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
  ToolSchema,
} from "../../../src/tool/definition/tool.js";
import type { ToolDispatcher } from "../../../src/tool/dispatcher/port/tool-dispatcher.js";
import {
  INTERRUPT_CALL_ID_METADATA_KEY,
  INTERRUPT_METADATA_KEY,
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
  void it("validates required runtime dependencies", async () => {
    const options = {
      context: newContext(),
      adapter: new ScriptedAdapter([[{ content: "done" }]]),
      dispatcher: noTools,
      tools: [],
      systemPrompt: "",
      modelParams: {},
      config: {},
      signal: AbortSignal.timeout(1_000),
    };
    await assert.rejects(
      runReactLoop({
        ...options,
        // @ts-expect-error Runtime validation protects untyped JavaScript callers.
        context: undefined,
      }),
      /context/i,
    );
    await assert.rejects(
      runReactLoop({
        ...options,
        // @ts-expect-error Runtime validation protects untyped JavaScript callers.
        adapter: undefined,
      }),
      /adapter/i,
    );
  });

  void it("streams a final answer, captures usage, and does not persist the configured system prompt", async () => {
    const events: RuntimeEvent[] = [];
    const adapter = new ScriptedAdapter([
      [
        { content: "最终" },
        {
          content: "回复",
          finishReason: "stop",
          usage: { promptTokens: 2, completionTokens: 3, totalTokens: 5 },
        },
        {
          content: null,
          usage: { promptTokens: 2, completionTokens: 3, totalTokens: 5 },
        },
      ],
    ]);
    const context = newContext((event: RuntimeEvent): void => {
      events.push(event);
    });

    const result = await runReactLoop({
      context,
      adapter,
      dispatcher: noTools,
      tools: [],
      systemPrompt: "runtime prompt",
      modelParams: {},
      config: {},
      signal: AbortSignal.timeout(1_000),
    });

    assert.equal(result.tokensUsed, 5);
    assert.equal(result.finishReason, "stop");
    assert.equal(result.llmContext.at(-1)?.content, "最终回复");
    assert.equal(
      result.llmContext.some((message) => message.role === "system"),
      false,
    );
    assert.equal(adapter.requests[0]?.messages[0]?.role, "system");
    assert.deepEqual(
      events.filter((event) => event.type === EVENT_TYPES.STATUS),
      [{ type: "status", code: "thinking" }],
    );
  });

  void it("preserves host system messages while stripping repeated configured prompts", async () => {
    const adapter = new ScriptedAdapter([[{ content: "ok" }]]);
    const context = new RuntimeContext({
      sessionId: "thread-1",
      checkpointId: "checkpoint-1",
      userId: "user-1",
      requestId: "request-1",
      traceId: "trace-1",
      checkpointRevision: 0n,
      fencingToken: 0n,
      messages: [],
      llmContext: [
        { role: "system", content: "runtime prompt" },
        { role: "system", content: "runtime prompt" },
        { role: "system", content: "host policy" },
        { role: "user", content: "history" },
      ],
    });

    const result = await runReactLoop({
      context,
      adapter,
      dispatcher: noTools,
      tools: [],
      systemPrompt: "runtime prompt",
      modelParams: {},
      config: {},
      signal: AbortSignal.timeout(1_000),
    });

    assert.deepEqual(
      adapter.requests[0]?.messages
        .slice(0, 2)
        .map((message) => message.content),
      ["runtime prompt", "host policy"],
    );
    assert.equal(result.llmContext[0]?.content, "host policy");
  });

  void it("executes tools, injects call context, and emits lifecycle events", async () => {
    const events: RuntimeEvent[] = [];
    const adapter = new ScriptedAdapter([
      [{ content: null, toolCalls: [toolCall("echo", "call-1")] }],
      [{ content: "done", finishReason: "stop" }],
    ]);
    const dispatcher = new FunctionDispatcher(
      (call: ToolCall, context: ToolCallContext): Promise<ToolResult> => {
        assert.equal(context.threadId, "thread-1");
        assert.equal(context.callId, call.id);
        assert.equal(context.checkpointRevision, 11n);
        context.eventSink?.({ type: EVENT_TYPES.TOKEN, content: "child" });
        return Promise.resolve({ content: `result:${call.function.name}` });
      },
    );

    const result = await runReactLoop({
      context: newContext((event: RuntimeEvent): void => {
        events.push(event);
      }),
      adapter,
      dispatcher,
      tools: [],
      systemPrompt: "",
      modelParams: {},
      config: {},
      signal: AbortSignal.timeout(1_000),
    });

    assert.equal(result.llmContext.at(-2)?.content, "result:echo");
    assert.equal(result.llmContext.at(-2)?.toolCallId, "call-1");
    assert.deepEqual(
      events.filter((event) => event.type === EVENT_TYPES.STATUS),
      [
        { type: "status", code: "thinking" },
        { type: "status", code: "analyzing_results" },
      ],
    );
    assert.equal(
      events.some(
        (event) =>
          event.type === EVENT_TYPES.TOOL_RESULT && event.error === undefined,
      ),
      true,
    );
  });

  void it("uses interrupting tools as an execution barrier and resumes from the suspension", async () => {
    const executed: string[] = [];
    const adapter = new ScriptedAdapter([
      [
        {
          content: null,
          toolCalls: [
            toolCall("side_effect", "call-a", 0),
            toolCall("ask", "call-b", 1),
          ],
        },
      ],
    ]);
    const dispatcher = new FunctionDispatcher(
      (call: ToolCall): Promise<ToolResult> => {
        executed.push(call.function.name);
        return Promise.resolve({
          content: "",
          signal: { kind: SIGNAL_KINDS.INTERRUPT, payload: { kind: "ask" } },
        });
      },
    );
    const tools: readonly ToolSchema[] = [
      {
        type: "function",
        function: { name: "side_effect", description: "", parameters: {} },
      },
      {
        type: "function",
        function: { name: "ask", description: "", parameters: {} },
        interrupting: true,
      },
    ];
    const context = newContext();

    const result = await runReactLoop({
      context,
      adapter,
      dispatcher,
      tools,
      systemPrompt: "",
      modelParams: {},
      config: {},
      signal: AbortSignal.timeout(1_000),
    });

    assert.deepEqual(executed, ["ask"]);
    assert.equal(result.stopReason, "awaiting_user");
    assert.equal(result.interrupt?.toolCallId, "call-b");
    assert.equal(
      context.metadata.get(INTERRUPT_CALL_ID_METADATA_KEY),
      "call-b",
    );
    assert.deepEqual(
      context.metadata.get(INTERRUPT_METADATA_KEY),
      result.interrupt,
    );
    assert.deepEqual(
      result.llmContext[1]?.toolCalls?.map((call) => call.id),
      ["call-b"],
    );

    const resumed = await runReactLoop({
      context: new RuntimeContext({
        sessionId: "thread-1",
        checkpointId: "checkpoint-1",
        userId: "user-1",
        requestId: "request-2",
        traceId: "trace-2",
        checkpointRevision: 12n,
        fencingToken: 30n,
        messages: [],
        llmContext: [
          ...result.llmContext,
          { role: "tool", content: "continue", toolCallId: "call-b" },
        ],
      }),
      adapter: new ScriptedAdapter([[{ content: "resumed" }]]),
      dispatcher: noTools,
      tools,
      systemPrompt: "",
      modelParams: {},
      config: {},
      signal: AbortSignal.timeout(1_000),
    });
    assert.equal(resumed.interrupt, undefined);
    assert.equal(resumed.llmContext.at(-1)?.content, "resumed");
  });
});
