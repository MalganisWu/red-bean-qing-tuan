import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { LlmChunk, LlmRequest } from "../../../src/llm/model/model.js";
import type { LlmAdapter } from "../../../src/llm/adapter/port/llm-adapter.js";
import { RuntimeContext } from "../../../src/pipeline/context/runtime-context.js";
import { EVENT_TYPES, type RuntimeEvent } from "../../../src/protocol/event.js";
import { SIGNAL_KINDS } from "../../../src/protocol/interrupt.js";
import type {
  ToolCall,
  ToolCallContext,
  ToolResult,
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
  void it("emits one token event for each streamed content chunk", async () => {
    const events: RuntimeEvent[] = [];

    await runReactLoop({
      context: newContext((event: RuntimeEvent): void => {
        events.push(event);
      }),
      adapter: new ScriptedAdapter([
        [
          { content: "你好" },
          { content: "，世界" },
          { content: "！", finishReason: "stop" },
        ],
      ]),
      dispatcher: noTools,
      tools: [],
      systemPrompt: "",
      modelParams: {},
      config: {},
      signal: AbortSignal.timeout(1_000),
    });

    assert.deepEqual(
      events
        .filter((event): boolean => event.type === EVENT_TYPES.TOKEN)
        .map((event): string =>
          event.type === EVENT_TYPES.TOKEN ? event.content : "",
        ),
      ["你好", "，世界", "！"],
    );
  });

  void it("notifies the message observer for each persisted assistant and tool message", async () => {
    const observed: string[] = [];

    await runReactLoop({
      context: newContext(),
      adapter: new ScriptedAdapter([
        [{ content: null, toolCalls: [toolCall("echo", "call-1")] }],
        [{ content: "完成", finishReason: "stop" }],
      ]),
      dispatcher: new FunctionDispatcher((): Promise<ToolResult> =>
        Promise.resolve({ content: "echo-result" }),
      ),
      tools: [],
      onMessage: (message): void => {
        observed.push(
          `${message.role}:${message.toolCallId ?? message.content ?? ""}`,
        );
      },
      systemPrompt: "",
      modelParams: {},
      config: {},
      signal: AbortSignal.timeout(1_000),
    });

    assert.deepEqual(observed, ["assistant:", "tool:call-1", "assistant:完成"]);
  });

  void it("emits token and tool lifecycle events for ordinary tool calls", async () => {
    const events: RuntimeEvent[] = [];

    await runReactLoop({
      context: newContext((event: RuntimeEvent): void => {
        events.push(event);
      }),
      adapter: new ScriptedAdapter([
        [{ content: "查询中", toolCalls: [toolCall("fetch", "call-fetch")] }],
        [{ content: "查询完成", finishReason: "stop" }],
      ]),
      dispatcher: new FunctionDispatcher((): Promise<ToolResult> =>
        Promise.resolve({ content: '{"ok":true}' }),
      ),
      tools: [],
      systemPrompt: "",
      modelParams: {},
      config: {},
      signal: AbortSignal.timeout(1_000),
    });

    assert.equal(
      events.some(
        (event): boolean =>
          event.type === EVENT_TYPES.TOKEN && event.content === "查询中",
      ),
      true,
    );
    assert.equal(
      events.some(
        (event): boolean =>
          event.type === EVENT_TYPES.TOOL_START &&
          event.callId === "call-fetch",
      ),
      true,
    );
    assert.equal(
      events.some(
        (event): boolean =>
          event.type === EVENT_TYPES.TOOL_RESULT &&
          event.callId === "call-fetch",
      ),
      true,
    );
  });

  void it("suppresses lifecycle events for a suspended ask tool", async () => {
    const events: RuntimeEvent[] = [];
    const result = await runReactLoop({
      context: newContext((event: RuntimeEvent): void => {
        events.push(event);
      }),
      adapter: new ScriptedAdapter([
        [{ content: null, toolCalls: [toolCall("ask", "call-ask")] }],
      ]),
      dispatcher: new FunctionDispatcher((): Promise<ToolResult> =>
        Promise.resolve({
          content: "",
          signal: { kind: SIGNAL_KINDS.INTERRUPT, payload: { kind: "ask" } },
        }),
      ),
      tools: [
        {
          type: "function",
          function: { name: "ask", description: "", parameters: {} },
          interrupting: true,
        },
      ],
      systemPrompt: "",
      modelParams: {},
      config: {},
      signal: AbortSignal.timeout(1_000),
    });

    assert.equal(result.stopReason, "awaiting_user");
    assert.equal(
      events.some(
        (event): boolean =>
          (event.type === EVENT_TYPES.TOOL_START ||
            event.type === EVENT_TYPES.TOOL_RESULT) &&
          event.callId === "call-ask",
      ),
      false,
    );
  });

  void it("suppresses lifecycle events by interrupting schema flag, not by tool name", async () => {
    const events: RuntimeEvent[] = [];
    const result = await runReactLoop({
      context: newContext((event: RuntimeEvent): void => {
        events.push(event);
      }),
      adapter: new ScriptedAdapter([
        [
          {
            content: null,
            toolCalls: [toolCall("custom_interrupt", "call-custom")],
          },
        ],
      ]),
      dispatcher: new FunctionDispatcher((): Promise<ToolResult> =>
        Promise.resolve({
          content: "",
          signal: { kind: SIGNAL_KINDS.INTERRUPT, payload: { kind: "custom" } },
        }),
      ),
      tools: [
        {
          type: "function",
          function: {
            name: "custom_interrupt",
            description: "",
            parameters: {},
          },
          interrupting: true,
        },
      ],
      systemPrompt: "",
      modelParams: {},
      config: {},
      signal: AbortSignal.timeout(1_000),
    });

    assert.equal(result.stopReason, "awaiting_user");
    assert.equal(
      events.some(
        (event): boolean =>
          (event.type === EVENT_TYPES.TOOL_START ||
            event.type === EVENT_TYPES.TOOL_RESULT) &&
          event.callId === "call-custom",
      ),
      false,
    );
  });

  void it("preserves partial content when a stream chunk fails", async () => {
    const adapter = new ScriptedAdapter([
      [
        { content: "partial" },
        { content: null, error: new Error("connection reset") },
      ],
    ]);
    const context = newContext();

    try {
      await runReactLoop({
        context,
        adapter,
        dispatcher: noTools,
        tools: [],
        systemPrompt: "",
        modelParams: {},
        config: {},
        signal: AbortSignal.timeout(1_000),
      });
      assert.fail("stream failure must reject");
    } catch (error: unknown) {
      assert.equal(error instanceof ReactLoopError, true);
      if (error instanceof ReactLoopError) {
        assert.match(error.message, /connection reset/);
        assert.equal(error.result.llmContext.at(-1)?.content, "partial");
        assert.equal(error.result.llmContext.at(-1)?.toolCalls, undefined);
      }
    }
  });

  void it("retries empty streams, counts usage once, and rejects repeated empty responses", async () => {
    const events: RuntimeEvent[] = [];
    const adapter = new ScriptedAdapter([
      [],
      [
        {
          content: "answer",
          usage: { promptTokens: 1, completionTokens: 1, totalTokens: 10 },
        },
        {
          content: null,
          usage: { promptTokens: 1, completionTokens: 1, totalTokens: 10 },
        },
      ],
    ]);
    const result = await runReactLoop({
      context: newContext((event: RuntimeEvent): void => {
        events.push(event);
      }),
      adapter,
      dispatcher: noTools,
      tools: [],
      systemPrompt: "",
      modelParams: {},
      config: {},
      signal: AbortSignal.timeout(1_000),
    });
    assert.equal(result.tokensUsed, 10);
    assert.equal(result.llmContext.at(-1)?.content, "answer");
    assert.equal(
      events.some(
        (event) =>
          event.type === EVENT_TYPES.STATUS &&
          event.code === "llm_empty_response_retry" &&
          event.attempt === 2 &&
          event.maxAttempts === 3,
      ),
      true,
    );

    await assert.rejects(
      runReactLoop({
        context: newContext(),
        adapter: new ScriptedAdapter([[], [], []]),
        dispatcher: noTools,
        tools: [],
        systemPrompt: "",
        modelParams: {},
        config: {},
        signal: AbortSignal.timeout(1_000),
      }),
      /empty response/i,
    );
  });
});
