/**
 * Runtime 的中性观测插件：只记录低基数调用属性。
 *
 * 全文件贯穿一条硬边界——**span 属性里不出现 prompt、模型输出、工具参数或工具结果**。
 * 记录的是「调了几次、调了什么名字、成功还是失败、属于哪个 trace」这类可聚合的量。
 * 一旦把正文写进属性，观测后端就从可丢弃的旁路变成了一个新的数据泄露面，
 * 而且基数会随用户内容爆炸。自定义 Tracer 实现同样受这条约束。
 */

import { RuntimeExecutionError } from "../run/error/runtime-execution-error.js";
import type { RuntimeResult } from "../run/result/runtime-result.js";
import type { LlmChunk, LlmRequest } from "../../llm/model/model.js";
import type { LlmAdapter } from "../../llm/adapter/port/llm-adapter.js";
import type {
  Attribute,
  Span,
  SpanStart,
  Tracer,
} from "../../observability/tracer/port/tracer.js";
import type {
  LlmMiddleware,
  PluginRegistry,
  RunInfo,
  RuntimePlugin,
  ToolMiddleware,
} from "../plugin/runtime-plugin.js";
import type {
  ToolCall,
  ToolCallContext,
  ToolResult,
} from "../../tool/definition/tool.js";
import type { ToolDispatcher } from "../../tool/dispatcher/port/tool-dispatcher.js";
import {
  type ChildRunRequest,
  type ChildRunResult,
  type ChildRunner,
} from "../../tool/delegation/runner/port/child-runner.js";
import { ChildRunError } from "../../tool/delegation/error/child-run-error.js";

/**
 * 把任意抛出物归一为 Error，供 span.end 承载。
 *
 * 非 Error 的抛出（字符串、对象）在观测后端没有堆栈可读，包一层才能让排障拿到位置信息；
 * 已经是 Error 的原样返回，保留其 cause 链不被切断。
 *
 * @param value - catch 到的任意抛出物
 * @returns 原 Error，或包装后的新 Error
 */
function normalizeError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

/**
 * 丢掉值为空串的属性。
 * 与序列化层「空值即缺席」保持同一套语义：一个 `""` 的属性既没有信息量，
 * 又会让「字段存在」这件事在不同后端上含义不一。
 *
 * @param attributes - 待过滤的属性；空串值的项会被剔除
 * @returns 只保留非空值属性的新数组
 */
function compactAttributes(
  ...attributes: readonly Attribute[]
): readonly Attribute[] {
  return attributes.filter(
    (attribute: Attribute): boolean => attribute.value.length > 0,
  );
}

/**
 * 开一个 span，并在开启前统一剔除空值属性。
 *
 * 所有 span 都必须经这里创建，保证「空值即缺席」的约定不被个别调用点绕过。
 *
 * @param tracer - 宿主提供的 Tracer，负责真正的 span 创建
 * @param start - span 的起始信息；其属性会先经 compactAttributes 过滤
 * @returns 已开启的 span，生命周期归调用方管理
 */
function startSpan(tracer: Tracer, start: SpanStart): Span {
  return tracer.start({
    name: start.name,
    attributes: compactAttributes(...start.attributes),
  });
}

/** 仅记录低基数调用属性的 LLM 装饰器，不采集请求或响应正文。 */
class TracedLlmAdapter implements LlmAdapter {
  /** 宿主注入的 Tracer；本层只写入低基数属性，不解释其内容。 */
  readonly #tracer: Tracer;
  /** 被包裹的真实适配器；调用前后补记 span，不改变其流式语义。 */
  readonly #next: LlmAdapter;

  public constructor(tracer: Tracer, next: LlmAdapter) {
    this.#tracer = tracer;
    this.#next = next;
  }

  /**
   * 只在「拿到迭代器」这一步建立 span，真正的采集交给 `traceStream`。
   *
   * 这一点容易写错：`streamCompletion` resolve 时流的读取才刚刚开始，
   * 若在这里 `span.end()`，span 的耗时会退化成「建连耗时」，
   * 流中途的错误也无处附着。所以 span 的所有权被移交给返回的生成器。
   *
   * @param request - LLM 请求；只取消息数与工具数作为低基数属性，不采集正文
   * @param signal - 调用方取消信号；原样透传给下游适配器
   * @returns 由 traceStream 接管的异步流，span 在流结束时才收尾
   */
  public async streamCompletion(
    request: LlmRequest,
    signal: AbortSignal,
  ): Promise<AsyncIterable<LlmChunk>> {
    const span = startSpan(this.#tracer, {
      name: "llm.stream",
      attributes: [
        { key: "llm.message_count", value: String(request.messages.length) },
        { key: "llm.tool_count", value: String(request.tools.length) },
      ],
    });
    try {
      const source = await span.within((): Promise<AsyncIterable<LlmChunk>> =>
        this.#next.streamCompletion(request, signal),
      );
      return traceStream(source, span);
    } catch (cause: unknown) {
      const error = normalizeError(cause);
      span.end(error);
      throw cause;
    }
  }
}

/**
 * 包裹整条流的消费，并在流真正结束时收尾 span。
 *
 * 三处细节：
 * - 每次 `iterator.next()` 都走 `span.within`，让异步上下文穿透到生产者一侧，
 *   否则上游创建的嵌套 span 会挂错父节点。
 * - 错误有两个来源：**带内**的错误 chunk（`item.value.error`，协议层用它表达
 *   「流还能继续但这一帧是错的」）和**带外**的抛出。两者都记，但只保留第一个，
 *   避免收尾时的二次错误覆盖掉真正的根因。
 * - `finally` 一定调用 `iterator.return()`：消费者提前 break 时上游需要被显式关闭，
 *   否则连接会挂到超时。
 *
 * @param source - 上游的 chunk 异步流
 * @param span - 已开启、由本生成器负责收尾的 span
 * @returns 逐帧透传的异步流；首个错误被记入 span，收尾时保证关闭上游迭代器
 */
async function* traceStream(
  source: AsyncIterable<LlmChunk>,
  span: Span,
): AsyncIterable<LlmChunk> {
  const iterator = source[Symbol.asyncIterator]();
  let streamError: Error | undefined;
  try {
    for (;;) {
      const item = await span.within((): Promise<IteratorResult<LlmChunk>> =>
        iterator.next(),
      );
      if (item.done) return;
      if (streamError === undefined && item.value.error) {
        streamError = item.value.error;
      }
      yield item.value;
    }
  } catch (cause: unknown) {
    streamError = normalizeError(cause);
    throw cause;
  } finally {
    try {
      await iterator.return?.();
    } catch (cause: unknown) {
      if (streamError === undefined) streamError = normalizeError(cause);
    }
    span.end(streamError);
  }
}

/** 记录工具生命周期的分发装饰器，不采集工具参数与输出。 */
class TracedToolDispatcher implements ToolDispatcher {
  /** 宿主注入的 Tracer；本层只写入低基数属性，不解释其内容。 */
  readonly #tracer: Tracer;
  /** 被包裹的真实分发器；工具结果与抛出的错误原样透传。 */
  readonly #next: ToolDispatcher;

  public constructor(tracer: Tracer, next: ToolDispatcher) {
    this.#tracer = tracer;
    this.#next = next;
  }

  /**
   * 分发一次工具调用并记一个 `tool.execute` span。
   *
   * span 属性只取自调用元数据（工具名、调用 ID、运行身份），绝不写入工具参数与输出，
   * 避免观测后端成为新的数据泄露面。失败时把归一后的错误挂到 span 再原样抛出。
   *
   * @param call - 工具调用的请求；只取函数名与调用 ID 作属性
   * @param context - 工具调用上下文；提供 thread/request/trace 标识
   * @param signal - 调用方取消信号；原样透传给下游分发器
   * @returns 下游返回的工具结果，未经本层改动
   */
  public async dispatch(
    call: ToolCall,
    context: ToolCallContext,
    signal: AbortSignal,
  ): Promise<ToolResult> {
    const span = startSpan(this.#tracer, {
      name: "tool.execute",
      attributes: [
        { key: "tool.name", value: call.function.name },
        { key: "tool.call_id", value: call.id },
        { key: "runtime.thread_id", value: context.threadId },
        { key: "runtime.request_id", value: context.requestId },
        { key: "runtime.trace_id", value: context.traceId },
      ],
    });
    try {
      const result = await span.within((): Promise<ToolResult> =>
        this.#next.dispatch(call, context, signal),
      );
      span.end();
      return result;
    } catch (cause: unknown) {
      span.end(normalizeError(cause));
      throw cause;
    }
  }
}

/**
 * 用观测装饰器包住模型适配器；返回的仍是 `LlmAdapter`，调用方无需感知被包过。
 * @param tracer - 宿主提供的 Tracer；本层只开启 `llm.stream` span，不解释其内容。
 * @param next - 被包裹的真实适配器；失败原样透传，这一层不吞错也不重试。
 * @returns 记录低基数调用属性的适配器；span 的生命周期移交给它返回的流。
 */
export function wrapLlm(tracer: Tracer, next: LlmAdapter): LlmAdapter {
  return new TracedLlmAdapter(tracer, next);
}

/**
 * 用观测装饰器包住工具分发器；每次 dispatch 记一个 `tool.execute` span。
 * @param tracer - 宿主提供的 Tracer；span 名固定为 `tool.execute`，属性只取自调用元数据。
 * @param next - 被包裹的真实分发器；工具结果与抛出的错误原样透传，本层不改变派发语义。
 * @returns 每次 dispatch 都记 span 的分发器；不采集工具参数与输出。
 */
export function wrapToolDispatcher(
  tracer: Tracer,
  next: ToolDispatcher,
): ToolDispatcher {
  return new TracedToolDispatcher(tracer, next);
}

/** 关联父子运行 Trace 的 ChildRunner 装饰器，不拥有子运行状态。 */
class TracedChildRunner implements ChildRunner {
  /** 宿主注入的 Tracer；本层只写入低基数属性，不解释其内容。 */
  readonly #tracer: Tracer;
  /** 被包裹的真实子运行执行器；结果与错误原样透传，本层不拥有子运行状态。 */
  readonly #next: ChildRunner;

  public constructor(tracer: Tracer, next: ChildRunner) {
    this.#tracer = tracer;
    this.#next = next;
  }

  /**
   * 执行一次子运行并记一个 `agent.delegate` span。
   *
   * 子运行失败时，若抛出物是 ChildRunError，会把失败那一刻的部分结果补记进 span，
   * 使排障能区分「模型一开始就报错」与「跑到一半才失败」；随后原样抛出，不吞错。
   *
   * @param request - 子运行请求；属性取自 agent/runtime 标识，不采集子运行正文
   * @param signal - 调用方取消信号；原样透传给下游执行器
   * @returns 下游返回的子运行结果
   */
  public async runChild(
    request: ChildRunRequest,
    signal: AbortSignal,
  ): Promise<ChildRunResult> {
    const span = startSpan(this.#tracer, {
      name: "agent.delegate",
      attributes: [
        { key: "agent.id", value: request.agentId },
        { key: "agent.execution_id", value: request.executionId },
        { key: "agent.parent_call_id", value: request.parentCallId },
        {
          key: "runtime.operation",
          value: request.executionId === "" ? "run" : "resume",
        },
        { key: "runtime.thread_id", value: request.threadId },
        { key: "runtime.request_id", value: request.requestId },
        { key: "runtime.trace_id", value: request.traceId },
      ],
    });
    try {
      const result = await span.within((): Promise<ChildRunResult> =>
        this.#next.runChild(request, signal),
      );
      span.setAttributes(
        ...compactAttributes(
          { key: "agent.execution_id", value: result.executionId ?? "" },
          { key: "runtime.status", value: result.status },
        ),
      );
      span.end();
      return result;
    } catch (cause: unknown) {
      const error = normalizeError(cause);
      // 子运行失败时它并非一无所知：ChildRunError 带着失败那一刻的部分结果。
      // 把这些补进 span，排障时才能区分「模型就报错了」和「跑到一半才失败」。
      if (cause instanceof ChildRunError) {
        span.setAttributes(
          ...compactAttributes(
            {
              key: "agent.execution_id",
              value: cause.result.executionId ?? request.executionId,
            },
            { key: "runtime.status", value: cause.result.status },
          ),
        );
      }
      span.end(error);
      throw cause;
    }
  }
}

/**
 * 用观测装饰器包住子运行执行器。
 * 与 LLM / Tool 的包装器不同，它记录的是 `agent.delegate` span——
 * 「父 Agent 委派了一次子任务」这件事本身，而不是子运行的内部调用。
 * @param tracer - 宿主提供的 Tracer；span 名固定为 `agent.delegate`，不随子运行的种类变化。
 * @param next - 被包裹的真实子运行执行器；子运行失败时原样抛出，仅在抛出前补记部分结果属性。
 * @returns 记录委派 span 的执行器；它不拥有子运行状态，也不参与恢复。
 */
export function wrapChildRunner(
  tracer: Tracer,
  next: ChildRunner,
): ChildRunner {
  return new TracedChildRunner(tracer, next);
}

/** 在构造期统一包装 Runtime、LLM、Tool 与子运行的高层观测插件。 */
export class RuntimeTracePlugin implements RuntimePlugin {
  /** 插件名，用于注册期的去重与排障时的来源识别。 */
  public readonly name = "observability.trace";
  /** 宿主注入的 Tracer；插件在构造期持有它，注册期用它包装三层调用来源。 */
  readonly #tracer: Tracer;

  public constructor(tracer: Tracer) {
    this.#tracer = tracer;
  }

  /**
   * 一次性登记 run 中间件与 LLM / Tool 包装器。
   * 三层覆盖的是三种不同的调用来源：run 中间件管顶层执行，
   * LLM 与 Tool 包装器管运行内部的调用（包括子运行自己发起的那些），
   * 因此子 Agent 的模型与工具调用同样会被记录，无需额外接线。
   * @param registry - 构造期开放的插件注册表；这里只登记能力，运行期不再改动它。
   */
  public register(registry: PluginRegistry): void {
    const llmMiddleware: LlmMiddleware = {
      wrapLlm: (next: LlmAdapter): LlmAdapter => wrapLlm(this.#tracer, next),
    };
    const toolMiddleware: ToolMiddleware = {
      wrapToolDispatcher: (next: ToolDispatcher): ToolDispatcher =>
        wrapToolDispatcher(this.#tracer, next),
    };
    registry.useRun(
      (
        info: RunInfo,
        next: (signal: AbortSignal) => Promise<RuntimeResult>,
        signal: AbortSignal,
      ): Promise<RuntimeResult> => this.run(info, next, signal),
    );
    registry.useLlm(llmMiddleware);
    registry.useTool(toolMiddleware);
  }

  /**
   * run 中间件的实体：为本次顶层运行开一个 `agent.<kind>` span 并收尾。
   *
   * 失败且抛出物是 RuntimeExecutionError 时，把其结果里的 status 补记进 span，
   * 保留一次「失败但有部分结果」的可见性；随后原样抛出，不改运行语义。
   *
   * @param info - 本次运行的元信息；kind 决定 span 名，其余标识写入属性
   * @param next - 下游执行函数；本层只负责在其前后补记 span
   * @param signal - 调用方取消信号；原样透传给下游
   * @returns 下游返回的终态结果
   */
  private async run(
    info: RunInfo,
    next: (signal: AbortSignal) => Promise<RuntimeResult>,
    signal: AbortSignal,
  ): Promise<RuntimeResult> {
    const span = startSpan(this.#tracer, {
      name: `agent.${info.kind}`,
      attributes: [
        { key: "runtime.operation", value: info.kind },
        { key: "runtime.thread_id", value: info.threadId },
        { key: "runtime.request_id", value: info.requestId },
        { key: "runtime.trace_id", value: info.traceId },
      ],
    });
    try {
      const result = await span.within((): Promise<RuntimeResult> =>
        next(signal),
      );
      span.setAttributes({ key: "runtime.status", value: result.status });
      span.end();
      return result;
    } catch (cause: unknown) {
      if (cause instanceof RuntimeExecutionError) {
        span.setAttributes({
          key: "runtime.status",
          value: cause.result.status,
        });
      }
      span.end(normalizeError(cause));
      throw cause;
    }
  }
}
