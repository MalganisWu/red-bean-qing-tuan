import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { LlmChunk, LlmRequest } from "../../../src/llm/model/model.js";
import type { LlmAdapter } from "../../../src/llm/adapter/port/llm-adapter.js";
import {
  AGENT_RESULT_METADATA_KEY,
  AGENT_RESULT_REASONS,
  TOKENS_USED_METADATA_KEY,
} from "../../../src/pipeline/execution/agent-result.js";
import { RuntimeContext } from "../../../src/pipeline/context/runtime-context.js";
import { HookFatalError } from "../../../src/pipeline/hook/hook-error.js";
import type { MessageHook } from "../../../src/pipeline/hook/port/message-hook.js";
import type { InterruptAssembler } from "../../../src/pipeline/interrupt/port/interrupt-assembler.js";
import type {
  ToolCall,
  ToolCallContext,
  ToolResult,
} from "../../../src/tool/definition/tool.js";
import type { ToolDispatcher } from "../../../src/tool/dispatcher/port/tool-dispatcher.js";
import { AgentNode } from "../../../src/pipeline/node/service/agent-node.js";

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

class SequenceAdapter implements LlmAdapter {
  public calls = 0;
  readonly #responses: readonly (readonly LlmChunk[])[];

  public constructor(responses: readonly (readonly LlmChunk[])[]) {
    this.#responses = responses;
  }

  public streamCompletion(
    _request: LlmRequest,
    _signal: AbortSignal,
  ): Promise<AsyncIterable<LlmChunk>> {
    const response = this.#responses[this.calls] ?? [];
    this.calls += 1;
    return Promise.resolve(stream(response));
  }
}

class NoopDispatcher implements ToolDispatcher {
  public dispatch(
    _call: ToolCall,
    _context: ToolCallContext,
    _signal: AbortSignal,
  ): Promise<ToolResult> {
    return Promise.resolve({ content: "" });
  }
}

class ConfigurableHook implements MessageHook {
  public userCalls = 0;
  readonly #userError: Error | undefined;
  readonly #assistantError: Error | undefined;

  public constructor(options: {
    readonly userError?: Error | undefined;
    readonly assistantError?: Error | undefined;
  }) {
    this.#userError = options.userError;
    this.#assistantError = options.assistantError;
  }

  public onUserMessage(): Promise<void> {
    this.userCalls += 1;
    return this.#userError
      ? Promise.reject(this.#userError)
      : Promise.resolve();
  }

  public onAssistantMessage(): Promise<void> {
    return this.#assistantError
      ? Promise.reject(this.#assistantError)
      : Promise.resolve();
  }

  public onToolMessage(): Promise<void> {
    return Promise.resolve();
  }
}

function newContext(): RuntimeContext {
  return new RuntimeContext({
    sessionId: "thread-1",
    checkpointId: "checkpoint-1",
    userId: "user-1",
    requestId: "request-1",
    traceId: "trace-1",
    checkpointRevision: 0n,
    fencingToken: 0n,
    messages: [{ role: "user", content: "hello" }],
    llmContext: [],
  });
}

void describe("Runtime TypeScript AgentNode", () => {
  void it("aborts on a fatal user hook before calling the model", async () => {
    const adapter = new SequenceAdapter([[{ content: "unused" }]]);
    const context = newContext();
    const node = new AgentNode({
      adapter,
      dispatcher: new NoopDispatcher(),
      tools: [],
      hook: new ConfigurableHook({
        userError: new HookFatalError(new Error("display persistence failed")),
      }),
      systemPrompt: "",
      modelParams: {},
      config: {},
    });

    await assert.rejects(
      node.execute(context, AbortSignal.timeout(1_000)),
      (error: unknown): boolean => error instanceof HookFatalError,
    );
    assert.equal(adapter.calls, 0);
    assert.deepEqual(context.metadata.get(AGENT_RESULT_METADATA_KEY), {
      success: false,
      reason: AGENT_RESULT_REASONS.HOOK_FATAL,
    });
  });

  void it("continues after a non-fatal hook error", async () => {
    const adapter = new SequenceAdapter([[{ content: "done" }]]);
    const hook = new ConfigurableHook({ userError: new Error("best effort") });
    const context = newContext();
    const node = new AgentNode({
      adapter,
      dispatcher: new NoopDispatcher(),
      tools: [],
      hook,
      systemPrompt: "",
      modelParams: {},
      config: {},
    });

    await node.execute(context, AbortSignal.timeout(1_000));
    assert.equal(adapter.calls, 1);
    assert.equal(hook.userCalls, 1);
    assert.deepEqual(context.metadata.get(AGENT_RESULT_METADATA_KEY), {
      success: true,
      reason: AGENT_RESULT_REASONS.COMPLETED,
    });
  });

  void it("keeps partial progress and token usage after a fatal assistant hook", async () => {
    const context = newContext();
    const node = new AgentNode({
      adapter: new SequenceAdapter([
        [
          {
            content: "partial",
            usage: { promptTokens: 3, completionTokens: 4, totalTokens: 7 },
          },
        ],
      ]),
      dispatcher: new NoopDispatcher(),
      tools: [],
      hook: new ConfigurableHook({
        assistantError: new HookFatalError(new Error("save failed")),
      }),
      systemPrompt: "",
      modelParams: {},
      config: {},
    });

    await assert.rejects(
      node.execute(context, AbortSignal.timeout(1_000)),
      /save failed/i,
    );
    assert.equal(context.llmContext.at(-1)?.content, "partial");
    assert.equal(context.metadata.get(TOKENS_USED_METADATA_KEY), 7);
    assert.deepEqual(context.metadata.get(AGENT_RESULT_METADATA_KEY), {
      success: false,
      reason: AGENT_RESULT_REASONS.HOOK_FATAL,
    });
  });

  void it("preserves the cancelled result reason", async () => {
    const context = newContext();
    const node = new AgentNode({
      adapter: new SequenceAdapter([[{ content: "unused" }]]),
      dispatcher: new NoopDispatcher(),
      tools: [],
      systemPrompt: "",
      modelParams: {},
      config: {},
    });

    await assert.rejects(
      node.execute(context, AbortSignal.abort(new Error("cancelled"))),
      /cancelled/i,
    );
    assert.deepEqual(context.metadata.get(AGENT_RESULT_METADATA_KEY), {
      success: false,
      reason: AGENT_RESULT_REASONS.CANCELLED,
    });
  });

  void it("assembles an interrupt and records awaiting-user status", async () => {
    let assembled = "";
    const assembler: InterruptAssembler = {
      assemble: (_context, interrupt): Promise<void> => {
        assembled = interrupt.toolCallId;
        return Promise.resolve();
      },
    };
    const context = newContext();
    const node = new AgentNode({
      adapter: new SequenceAdapter([
        [
          {
            content: null,
            toolCalls: [
              {
                id: "call-ask",
                type: "function",
                function: { name: "ask", arguments: "{}" },
              },
            ],
          },
        ],
      ]),
      dispatcher: {
        dispatch: (): Promise<ToolResult> =>
          Promise.resolve({
            content: "",
            signal: { kind: "interrupt", payload: { question: "continue?" } },
          }),
      },
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
      interruptAssembler: assembler,
    });

    await node.execute(context, AbortSignal.timeout(1_000));
    assert.equal(assembled, "call-ask");
    assert.deepEqual(context.metadata.get(AGENT_RESULT_METADATA_KEY), {
      success: true,
      reason: AGENT_RESULT_REASONS.AWAITING_USER,
    });
  });
});
