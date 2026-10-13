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
 * Runtime 的中性观测插件：只记录低基数调用属性。
 *
 * 全文件贯穿一条硬边界——**span 属性里不出现 prompt、模型输出、工具参数或工具结果**。
 * 记录的是「调了几次、调了什么名字、成功还是失败、属于哪个 trace」这类可聚合的量。
 * 一旦把正文写进属性，观测后端就从可丢弃的旁路变成了一个新的数据泄露面，
 * 而且基数会随用户内容爆炸。自定义 Tracer 实现同样受这条约束。
 */
function normalizeError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

/**
 * 丢掉值为空串的属性。
 * 与序列化层「空值即缺席」保持同一套语义：一个 `""` 的属性既没有信息量，
 * 又会让「字段存在」这件事在不同后端上含义不一。
 */
function compactAttributes(
  ...attributes: readonly Attribute[]
): readonly Attribute[] {
  return attributes.filter(
    (attribute: Attribute): boolean => attribute.value.length > 0,
  );
}

function startSpan(tracer: Tracer, start: SpanStart): Span {
  return tracer.start({
    name: start.name,
    attributes: compactAttributes(...start.attributes),
  });
}

/** 仅记录低基数调用属性的 LLM 装饰器，不采集请求或响应正文。 */
class TracedLlmAdapter implements LlmAdapter {
  readonly #tracer: Tracer;
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
  readonly #tracer: Tracer;
  readonly #next: ToolDispatcher;

  public constructor(tracer: Tracer, next: ToolDispatcher) {
    this.#tracer = tracer;
    this.#next = next;
  }

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
  readonly #tracer: Tracer;
  readonly #next: ChildRunner;

  public constructor(tracer: Tracer, next: ChildRunner) {
    this.#tracer = tracer;
    this.#next = next;
  }

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
