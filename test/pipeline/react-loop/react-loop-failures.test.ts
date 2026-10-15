import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { LlmChunk, LlmRequest } from "../../../src/llm/model/model.js";
import type { LlmAdapter } from "../../../src/llm/adapter/port/llm-adapter.js";
import { RuntimeContext } from "../../../src/pipeline/context/runtime-context.js";
import { EVENT_TYPES, type RuntimeEvent } from "../../../src/protocol/event.js";
import type {
  ToolCall,
  ToolCallContext,
  ToolResult,
  ToolSchema,
} from "../../../src/tool/definition/tool.js";
import type { ToolDispatcher } from "../../../src/tool/dispatcher/port/tool-dispatcher.js";
import {
  ReactLoopError,
  runReactLoop,
} from "../../../src/pipeline/react-loop/react-loop.js";

function stream(chunks: readonly LlmChunk[]): AsyncIterable<LlmChunk> {
  return {
    [Symbol.asyncIterator](): AsyncIterator<LlmChunk> {
      let index = 0;
      return {
        next(): Promise<IteratorResult<LlmChunk>> {
          const chunk = chunks[index];
          index += 1;
          return chunk
            ? Promise.resolve({ done: false, value: chunk })
            : Promise.resolve({ done: true, value: undefined });
        },
      };
    },
  };
}

class ScriptedAdapter implements LlmAdapter {
  public readonly requests: LlmRequest[] = [];
  readonly #responses: readonly (readonly LlmChunk[])[];
  #index = 0;

  public constructor(responses: readonly (readonly LlmChunk[])[]) {
    this.#responses = responses;
  }

  public streamCompletion(
    request: LlmRequest,
  ): Promise<AsyncIterable<LlmChunk>> {
    this.requests.push(request);
    const chunks = this.#responses[this.#index] ?? [];
    this.#index += 1;
    return Promise.resolve(stream(chunks));
  }
}

class FunctionDispatcher implements ToolDispatcher {
  readonly #dispatch: (
    call: ToolCall,
    context: ToolCallContext,
    signal: AbortSignal,
  ) => Promise<ToolResult>;

  public constructor(
    dispatch: (
      call: ToolCall,
      context: ToolCallContext,
      signal: AbortSignal,
    ) => Promise<ToolResult>,
  ) {
    this.#dispatch = dispatch;
  }

  public dispatch(
    call: ToolCall,
    context: ToolCallContext,
    signal: AbortSignal,
  ): Promise<ToolResult> {
    return this.#dispatch(call, context, signal);
  }
}

function newContext(eventSink?: (event: RuntimeEvent) => void): RuntimeContext {
  return new RuntimeContext({
    sessionId: "thread-1",
    checkpointId: "checkpoint-1",
    userId: "user-1",
    requestId: "request-1",
    traceId: "trace-1",
    checkpointRevision: 11n,
    fencingToken: 29n,
    messages: [{ role: "user", content: "hello" }],
    llmContext: [],
    eventSink,
  });
}

const noTools = new FunctionDispatcher((): Promise<ToolResult> =>
  Promise.reject(new Error("tool must not be called")),
);

function toolCall(name: string, id: string, index = 0): ToolCall {
  return {
    index,
    id,
    type: "function",
    function: { name, arguments: "{}" },
  };
}

void describe("Runtime TypeScript ReAct loop", () => {
  void it("stops at the configured maximum tool iterations", async () => {
    const result = await runReactLoop({
      context: newContext(),
      adapter: new ScriptedAdapter([
        [{ content: null, toolCalls: [toolCall("echo", "call-1")] }],
      ]),
      dispatcher: new FunctionDispatcher((): Promise<ToolResult> =>
        Promise.resolve({ content: "result" }),
      ),
      tools: [],
      systemPrompt: "",
      modelParams: {},
      config: { maxToolIterations: 1 },
      signal: AbortSignal.timeout(1_000),
    });

    assert.equal(result.stopReason, "max_iterations");
    assert.equal(result.llmContext.at(-1)?.role, "tool");
  });

  void it("marks the result cancelled when the main request is aborted", async () => {
    const controller = new AbortController();
    const cancellation = new Error("cancelled by caller");
    controller.abort(cancellation);

    await assert.rejects(
      runReactLoop({
        context: newContext(),
        adapter: new ScriptedAdapter([[{ content: "unused" }]]),
        dispatcher: noTools,
        tools: [],
        systemPrompt: "",
        modelParams: {},
        config: {},
        signal: controller.signal,
      }),
      (error: unknown): boolean => {
        assert.equal(error instanceof ReactLoopError, true);
        if (!(error instanceof ReactLoopError)) return false;
        assert.equal(error.result.cancelled, true);
        assert.equal(error.cause, cancellation);
        return true;
      },
    );
  });

  void it("does not wait for a misbehaving tool after request cancellation", async () => {
    const controller = new AbortController();
    const cancellation = new Error("cancel while tool is running");
    const startedAt = Date.now();
    const running = runReactLoop({
      context: newContext(),
      adapter: new ScriptedAdapter([
        [{ content: null, toolCalls: [toolCall("blocked", "call-1")] }],
      ]),
      dispatcher: new FunctionDispatcher((): Promise<ToolResult> => {
        controller.abort(cancellation);
        return new Promise(() => {});
      }),
      tools: [],
      systemPrompt: "",
      modelParams: {},
      config: {},
      signal: controller.signal,
    });

    await assert.rejects(running, (error: unknown): boolean => {
      assert.equal(error instanceof ReactLoopError, true);
      if (!(error instanceof ReactLoopError)) return false;
      assert.equal(error.result.cancelled, true);
      assert.equal(error.cause, cancellation);
      return true;
    });
    assert.ok(Date.now() - startedAt < 500);
  });

  void it("times out a misbehaving tool without waiting for it", async () => {
    const startedAt = Date.now();
    const result = await runReactLoop({
      context: newContext(),
      adapter: new ScriptedAdapter([
        [{ content: null, toolCalls: [toolCall("blocked", "call-1")] }],
      ]),
      dispatcher: new FunctionDispatcher(
        (): Promise<ToolResult> => new Promise(() => {}),
      ),
      tools: [],
      systemPrompt: "",
      modelParams: {},
      config: { maxToolIterations: 1, toolTimeoutSeconds: 1 },
      signal: AbortSignal.timeout(3_000),
    });

    assert.equal(result.stopReason, "max_iterations");
    assert.ok(Date.now() - startedAt < 2_000);
    assert.match(result.llmContext.at(-1)?.content ?? "", /timeout/i);
  });

  void it("keeps concurrent tool results matched to call order", async () => {
    const result = await runReactLoop({
      context: newContext(),
      adapter: new ScriptedAdapter([
        [
          {
            content: null,
            toolCalls: [
              toolCall("slow", "call-slow", 0),
              toolCall("fast", "call-fast", 1),
            ],
          },
        ],
      ]),
      dispatcher: new FunctionDispatcher(
        (call: ToolCall): Promise<ToolResult> =>
          new Promise((resolve): void => {
            setTimeout(
              (): void => resolve({ content: `result:${call.function.name}` }),
              call.function.name === "slow" ? 20 : 0,
            );
          }),
      ),
      tools: [],
      systemPrompt: "",
      modelParams: {},
      config: { maxToolIterations: 1 },
      signal: AbortSignal.timeout(1_000),
    });

    const toolMessages = result.llmContext.filter(
      (message): boolean => message.role === "tool",
    );
    assert.deepEqual(
      toolMessages.map((message) => [message.toolCallId, message.content]),
      [
        ["call-slow", "result:slow"],
        ["call-fast", "result:fast"],
      ],
    );
  });

  void it("emits a structured error event when a tool fails", async () => {
    const events: RuntimeEvent[] = [];
    const result = await runReactLoop({
      context: newContext((event: RuntimeEvent): void => {
        events.push(event);
      }),
      adapter: new ScriptedAdapter([
        [{ content: null, toolCalls: [toolCall("broken", "call-1")] }],
        [{ content: "fallback" }],
      ]),
      dispatcher: new FunctionDispatcher((): Promise<ToolResult> =>
        Promise.reject(new Error("connection refused")),
      ),
      tools: [],
      systemPrompt: "",
      modelParams: {},
      config: {},
      signal: AbortSignal.timeout(1_000),
    });

    assert.equal(result.llmContext.at(-1)?.content, "fallback");
    const failure = events.find(
      (event): boolean =>
        event.type === EVENT_TYPES.TOOL_RESULT && event.error !== undefined,
    );
    assert.deepEqual(failure, {
      type: EVENT_TYPES.TOOL_RESULT,
      toolName: "broken",
      callId: "call-1",
      content: JSON.stringify({ error: "connection refused" }),
      error: "connection refused",
    });
  });

  void it("rejects multiple interrupting tool calls before dispatch", async () => {
    let dispatches = 0;
    const interruptingTools: readonly ToolSchema[] = [
      {
        type: "function",
        function: { name: "ask-a", description: "", parameters: {} },
        interrupting: true,
      },
      {
        type: "function",
        function: { name: "ask-b", description: "", parameters: {} },
        interrupting: true,
      },
    ];

    await assert.rejects(
      runReactLoop({
        context: newContext(),
        adapter: new ScriptedAdapter([
          [
            {
              content: null,
              toolCalls: [
                toolCall("ask-a", "call-a", 0),
                toolCall("ask-b", "call-b", 1),
              ],
            },
          ],
        ]),
        dispatcher: new FunctionDispatcher((): Promise<ToolResult> => {
          dispatches += 1;
          return Promise.resolve({ content: "" });
        }),
        tools: interruptingTools,
        systemPrompt: "",
        modelParams: {},
        config: {},
        signal: AbortSignal.timeout(1_000),
      }),
      /多个 interrupting 工具调用/,
    );
    assert.equal(dispatches, 0);
  });
});
