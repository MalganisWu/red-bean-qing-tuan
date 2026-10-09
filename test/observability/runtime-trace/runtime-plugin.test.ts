import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import { describe, it } from "node:test";

import { AgentRuntime } from "../../../src/runtime/public-api.js";
import type { LlmChunk, LlmRequest } from "../../../src/llm/model/model.js";
import type { LlmAdapter } from "../../../src/llm/adapter/port/llm-adapter.js";
import type {
  Attribute,
  Span,
  SpanStart,
  Tracer,
} from "../../../src/observability/tracer/port/tracer.js";
import {
  RuntimeTracePlugin,
  wrapChildRunner,
} from "../../../src/runtime/observability/runtime-trace-plugin.js";
import type { JsonValue } from "../../../src/protocol/json.js";
import type {
  Tool,
  ToolCallContext,
  ToolResult,
} from "../../../src/tool/definition/tool.js";
import {
  CHILD_RUN_STATUSES,
  ChildRunError,
  type ChildRunRequest,
  type ChildRunResult,
  type ChildRunner,
} from "../../../src/tool/delegation/service/delegation-tool.js";

function stream(chunks: readonly LlmChunk[]): AsyncIterable<LlmChunk> {
  return {
    [Symbol.asyncIterator](): AsyncIterator<LlmChunk> {
      let index = 0;
      return {
        next(): Promise<IteratorResult<LlmChunk>> {
          const chunk = chunks[index];
          index += 1;
          return chunk === undefined
            ? Promise.resolve({ done: true, value: undefined })
            : Promise.resolve({ done: false, value: chunk });
        },
      };
    },
  };
}

class RecordedSpan implements Span {
  public readonly name: string;
  public readonly depth: number;
  public readonly attributes = new Map<string, string>();
  public ended = false;
  public error: Error | undefined;
  readonly #storage: AsyncLocalStorage<number>;

  public constructor(
    start: SpanStart,
    depth: number,
    storage: AsyncLocalStorage<number>,
  ) {
    this.name = start.name;
    this.depth = depth;
    this.#storage = storage;
    this.setAttributes(...start.attributes);
  }

  public setAttributes(...attributes: readonly Attribute[]): void {
    for (const attribute of attributes) {
      this.attributes.set(attribute.key, attribute.value);
    }
  }

  public within<TValue>(operation: () => Promise<TValue>): Promise<TValue> {
    return this.#storage.run(this.depth + 1, operation);
  }

  public end(error?: Error): void {
    this.ended = true;
    this.error = error;
  }
}

class RecordingTracer implements Tracer {
  public readonly storage = new AsyncLocalStorage<number>();
  public readonly spans: RecordedSpan[] = [];

  public start(start: SpanStart): Span {
    const span = new RecordedSpan(
      start,
      this.storage.getStore() ?? 0,
      this.storage,
    );
    this.spans.push(span);
    return span;
  }
}

class SequenceModel implements LlmAdapter {
  public readonly depths: number[] = [];
  #call = 0;
  readonly #tracer: RecordingTracer;

  public constructor(tracer: RecordingTracer) {
    this.#tracer = tracer;
  }

  public streamCompletion(
    _request: LlmRequest,
    _signal: AbortSignal,
  ): Promise<AsyncIterable<LlmChunk>> {
    this.depths.push(this.#tracer.storage.getStore() ?? 0);
    this.#call += 1;
    return Promise.resolve(
      this.#call === 1
        ? stream([
            {
              content: null,
              toolCalls: [
                {
                  id: "call-1",
                  type: "function",
                  function: { name: "probe", arguments: "{}" },
                },
              ],
            },
          ])
        : stream([{ content: "done", finishReason: "stop" }]),
    );
  }
}

class ProbeTool implements Tool {
  public readonly name = "probe";
  public readonly schema = {
    type: "function",
    function: { name: this.name, description: "", parameters: {} },
  };
  public depth = 0;
  readonly #tracer: RecordingTracer;

  public constructor(tracer: RecordingTracer) {
    this.#tracer = tracer;
  }

  public execute(
    _params: JsonValue,
    _context: ToolCallContext,
    _signal: AbortSignal,
  ): Promise<ToolResult> {
    this.depth = this.#tracer.storage.getStore() ?? 0;
    return Promise.resolve({ content: "ok" });
  }
}

void describe("Runtime TypeScript observability plugin", () => {
  void it("creates nested run, LLM, and tool spans with low-cardinality attributes", async () => {
    const tracer = new RecordingTracer();
    const model = new SequenceModel(tracer);
    const tool = new ProbeTool(tracer);
    const runtime = new AgentRuntime({
      model,
      tools: [tool],
      plugins: [new RuntimeTracePlugin(tracer)],
    });
    const result = await runtime.run(
      {
        threadId: "thread-1",
        requestId: "request-1",
        traceId: "trace-1",
        input: "start",
      },
      AbortSignal.timeout(1_000),
    );

    assert.equal(result.output, "done");
    assert.deepEqual(
      tracer.spans.map((span): string => span.name),
      ["agent.run", "llm.stream", "tool.execute", "llm.stream"],
    );
    assert.deepEqual(
      tracer.spans.map((span): number => span.depth),
      [0, 1, 1, 1],
    );
    assert.deepEqual(model.depths, [2, 2]);
    assert.equal(tool.depth, 2);
    assert.equal(
      tracer.spans[0]?.attributes.get("runtime.request_id"),
      "request-1",
    );
    assert.equal(
      tracer.spans[0]?.attributes.get("runtime.trace_id"),
      "trace-1",
    );
    assert.equal(tracer.spans[2]?.attributes.get("tool.name"), "probe");
    assert.equal(tracer.spans[2]?.attributes.get("tool.call_id"), "call-1");
    for (const span of tracer.spans) {
      assert.equal(span.ended, true);
      assert.equal(span.error, undefined);
    }
    await runtime.close(AbortSignal.timeout(1_000));
  });

  void it("traces child runs without recording prompts or output", async () => {
    const tracer = new RecordingTracer();
    let runnerDepth = 0;
    const runner: ChildRunner = {
      runChild: (
        _request: ChildRunRequest,
        _signal: AbortSignal,
      ): Promise<ChildRunResult> => {
        runnerDepth = tracer.storage.getStore() ?? 0;
        return Promise.resolve({
          status: CHILD_RUN_STATUSES.COMPLETED,
          executionId: "child-1",
          output: "private output",
        });
      },
    };
    const wrapped = wrapChildRunner(tracer, runner);
    const result = await tracer.storage.run(2, (): Promise<ChildRunResult> =>
      wrapped.runChild(
        {
          agentId: "researcher",
          executionId: "",
          parentCallId: "call-1",
          threadId: "thread-1",
          userId: "user-1",
          requestId: "request-1",
          traceId: "trace-1",
          instruction: "private instruction",
          context: "private context",
          expectedFormat: "markdown",
        },
        AbortSignal.timeout(1_000),
      ),
    );

    assert.equal(result.executionId, "child-1");
    assert.equal(runnerDepth, 3);
    const span = tracer.spans[0];
    assert.equal(span?.name, "agent.delegate");
    assert.equal(span?.depth, 2);
    assert.deepEqual(Object.fromEntries(span?.attributes ?? []), {
      "agent.id": "researcher",
      "agent.execution_id": "child-1",
      "agent.parent_call_id": "call-1",
      "runtime.operation": "run",
      "runtime.thread_id": "thread-1",
      "runtime.request_id": "request-1",
      "runtime.trace_id": "trace-1",
      "runtime.status": "completed",
    });
    assert.doesNotMatch(
      JSON.stringify(Object.fromEntries(span?.attributes ?? [])),
      /private/,
    );
  });

  void it("records resume failures while preserving the child result and error", async () => {
    const expected = new Error("child unavailable");
    const partial: ChildRunResult = {
      status: CHILD_RUN_STATUSES.FAILED,
      executionId: "child-existing",
    };
    const runner: ChildRunner = {
      runChild: (): Promise<ChildRunResult> =>
        Promise.reject(new ChildRunError(expected.message, partial, expected)),
    };
    const tracer = new RecordingTracer();
    const wrapped = wrapChildRunner(tracer, runner);
    let captured: ChildRunError | undefined;
    try {
      await wrapped.runChild(
        {
          agentId: "researcher",
          executionId: "child-existing",
          parentCallId: "",
          threadId: "",
          userId: "",
          requestId: "",
          traceId: "",
          instruction: "",
          context: "",
          expectedFormat: "",
        },
        AbortSignal.timeout(1_000),
      );
    } catch (cause: unknown) {
      if (cause instanceof ChildRunError) captured = cause;
    }
    assert.equal(captured?.result.status, CHILD_RUN_STATUSES.FAILED);
    const span = tracer.spans[0];
    assert.equal(span?.ended, true);
    assert.equal(span?.error, captured);
    assert.equal(span?.attributes.get("runtime.operation"), "resume");
    assert.equal(span?.attributes.get("runtime.status"), "failed");
    assert.equal(span?.attributes.get("agent.execution_id"), "child-existing");
  });
});
