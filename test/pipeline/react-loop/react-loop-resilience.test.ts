import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { RuntimeConfig } from "../../../src/runtime/config/runtime-config.js";
import { LLM_ERROR_KINDS, LlmError } from "../../../src/llm/error/llm-error.js";
import type { LlmChunk, LlmRequest } from "../../../src/llm/model/model.js";
import type { LlmAdapter } from "../../../src/llm/adapter/port/llm-adapter.js";
import { RuntimeContext } from "../../../src/pipeline/context/runtime-context.js";
import { EVENT_TYPES, type RuntimeEvent } from "../../../src/protocol/event.js";
import { SIGNAL_KINDS, type Signal } from "../../../src/protocol/interrupt.js";
import type {
  ToolCall,
  ToolCallContext,
  ToolResult,
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
  void it("rejects an unknown signal kind from an untrusted plugin", async () => {
    const signal: Signal = { kind: SIGNAL_KINDS.INTERRUPT, payload: {} };
    Object.defineProperty(signal, "kind", { value: "made_up_kind" });

    await assert.rejects(
      runReactLoop({
        context: newContext(),
        adapter: new ScriptedAdapter([
          [{ content: null, toolCalls: [toolCall("plugin", "call-1")] }],
        ]),
        dispatcher: new FunctionDispatcher((): Promise<ToolResult> =>
          Promise.resolve({ content: "", signal }),
        ),
        tools: [],
        systemPrompt: "",
        modelParams: {},
        config: {},
        signal: AbortSignal.timeout(1_000),
      }),
      /unknown engine signal kind/i,
    );
  });

  void it("contains a synchronous tool plugin failure", async () => {
    const result = await runReactLoop({
      context: newContext(),
      adapter: new ScriptedAdapter([
        [{ content: null, toolCalls: [toolCall("broken", "call-1")] }],
      ]),
      dispatcher: new FunctionDispatcher((): Promise<ToolResult> => {
        throw new Error("broken plugin");
      }),
      tools: [],
      systemPrompt: "",
      modelParams: {},
      config: { maxToolIterations: 1 },
      signal: AbortSignal.timeout(1_000),
    });

    assert.match(result.llmContext.at(-1)?.content ?? "", /broken plugin/i);
  });

  void it("emits structured LLM retry status fields", async () => {
    const events: RuntimeEvent[] = [];
    const controller = new AbortController();
    const adapter: LlmAdapter = {
      streamCompletion: (): Promise<AsyncIterable<LlmChunk>> => {
        controller.abort(new Error("stop retry backoff"));
        return Promise.reject(
          new LlmError(LLM_ERROR_KINDS.TEMPORARY, new Error("retry me")),
        );
      },
    };

    await assert.rejects(
      runReactLoop({
        context: newContext((event: RuntimeEvent): void => {
          events.push(event);
        }),
        adapter,
        dispatcher: noTools,
        tools: [],
        systemPrompt: "",
        modelParams: {},
        config: { maxLlmRetries: 2 },
        signal: controller.signal,
      }),
      /stop retry backoff/i,
    );
    assert.equal(
      events.some(
        (event): boolean =>
          event.type === EVENT_TYPES.STATUS &&
          event.code === "llm_retry" &&
          event.attempt === 2 &&
          event.maxAttempts === 3,
      ),
      true,
    );
  });

  void it("clears stale interrupt metadata before a new run", async () => {
    const context = newContext();
    context.metadata.set(INTERRUPT_CALL_ID_METADATA_KEY, "stale-call");
    context.metadata.set(INTERRUPT_METADATA_KEY, {
      toolCallId: "stale-call",
      toolName: "ask",
      arguments: {},
      payload: {},
    });

    await runReactLoop({
      context,
      adapter: new ScriptedAdapter([[{ content: "done" }]]),
      dispatcher: noTools,
      tools: [],
      systemPrompt: "",
      modelParams: {},
      config: {},
      signal: AbortSignal.timeout(1_000),
    });

    assert.equal(context.metadata.has(INTERRUPT_CALL_ID_METADATA_KEY), false);
    assert.equal(context.metadata.has(INTERRUPT_METADATA_KEY), false);
  });

  void it("times out an idle stream without waiting for the adapter", async () => {
    const adapter: LlmAdapter = {
      streamCompletion: (): Promise<AsyncIterable<LlmChunk>> =>
        Promise.resolve({
          [Symbol.asyncIterator](): AsyncIterator<LlmChunk> {
            return {
              next: (): Promise<IteratorResult<LlmChunk>> =>
                new Promise(() => {}),
            };
          },
        }),
    };
    const config: RuntimeConfig = { llmTimeoutSeconds: 1 };

    await assert.rejects(
      runReactLoop({
        context: newContext(),
        adapter,
        dispatcher: noTools,
        tools: [],
        systemPrompt: "",
        modelParams: {},
        config,
        signal: AbortSignal.timeout(3_000),
      }),
      /超时/,
    );
  });
});
