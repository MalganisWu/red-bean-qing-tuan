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

function normalizeError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

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

export function wrapLlm(tracer: Tracer, next: LlmAdapter): LlmAdapter {
  return new TracedLlmAdapter(tracer, next);
}

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

export function wrapChildRunner(
  tracer: Tracer,
  next: ChildRunner,
): ChildRunner {
  return new TracedChildRunner(tracer, next);
}

/** 在构造期统一包装 Runtime、LLM、Tool 与子运行的高层观测插件。 */
export class RuntimeTracePlugin implements RuntimePlugin {
  public readonly name = "observability.trace";
  readonly #tracer: Tracer;

  public constructor(tracer: Tracer) {
    this.#tracer = tracer;
  }

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
