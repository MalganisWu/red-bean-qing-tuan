import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { LlmChunk, LlmRequest } from "../../../src/llm/model/model.js";
import type { LlmAdapter } from "../../../src/llm/adapter/port/llm-adapter.js";
import { RuntimeContext } from "../../../src/pipeline/context/runtime-context.js";
import { SIGNAL_KINDS } from "../../../src/protocol/interrupt.js";
import type {
  ToolCall,
  ToolCallContext,
  ToolResult,
  ToolSchema,
} from "../../../src/tool/definition/tool.js";
import type { ToolDispatcher } from "../../../src/tool/dispatcher/port/tool-dispatcher.js";
import { runReactLoop } from "../../../src/pipeline/react-loop/react-loop.js";

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

class InterruptExampleAdapter implements LlmAdapter {
  #calls = 0;

  public streamCompletion(
    _request: LlmRequest,
    _signal: AbortSignal,
  ): Promise<AsyncIterable<LlmChunk>> {
    this.#calls += 1;
    return Promise.resolve(
      this.#calls === 1
        ? stream([
            {
              content: null,
              toolCalls: [
                {
                  id: "call-ask-1",
                  type: "function",
                  function: {
                    name: "ask_user",
                    arguments: '{"question":"继续吗？"}',
                  },
                },
              ],
            },
          ])
        : stream([{ content: "好的，已确认。任务完成。" }]),
    );
  }
}

class AskDispatcher implements ToolDispatcher {
  public dispatch(
    call: ToolCall,
    _context: ToolCallContext,
    _signal: AbortSignal,
  ): Promise<ToolResult> {
    if (call.function.name !== "ask_user") {
      return Promise.reject(new Error(`unknown tool ${call.function.name}`));
    }
    return Promise.resolve({
      content: "",
      signal: {
        kind: SIGNAL_KINDS.INTERRUPT,
        payload: { question: "继续吗？" },
      },
    });
  }
}

void describe("Runtime TypeScript interrupt example", () => {
  void it("suspends for a tool answer and resumes the same model context", async () => {
    const adapter = new InterruptExampleAdapter();
    const dispatcher = new AskDispatcher();
    const tool: ToolSchema = {
      type: "function",
      function: {
        name: "ask_user",
        description: "向用户提问并等待回答",
        parameters: {
          type: "object",
          properties: { question: { type: "string" } },
        },
      },
      interrupting: true,
    };
    const firstContext = new RuntimeContext({
      sessionId: "session-1",
      checkpointId: "checkpoint-1",
      userId: "user-1",
      requestId: "request-1",
      traceId: "trace-1",
      checkpointRevision: 0n,
      fencingToken: 0n,
      messages: [],
      llmContext: [],
    });
    const first = await runReactLoop({
      context: firstContext,
      adapter,
      dispatcher,
      tools: [tool],
      systemPrompt: "你是助手。",
      modelParams: {},
      config: {},
      signal: AbortSignal.timeout(1_000),
    });
    assert.equal(first.interrupt?.toolCallId, "call-ask-1");
    assert.deepEqual(first.interrupt?.payload, { question: "继续吗？" });

    const resumeContext = new RuntimeContext({
      sessionId: "session-1",
      checkpointId: "checkpoint-1",
      userId: "user-1",
      requestId: "request-2",
      traceId: "trace-1",
      checkpointRevision: 0n,
      fencingToken: 0n,
      llmContext: first.llmContext,
      messages: [{ role: "tool", content: "是", toolCallId: "call-ask-1" }],
    });
    const resumed = await runReactLoop({
      context: resumeContext,
      adapter,
      dispatcher,
      tools: [tool],
      systemPrompt: "",
      modelParams: {},
      config: {},
      signal: AbortSignal.timeout(1_000),
    });
    assert.equal(resumed.interrupt, undefined);
    assert.equal(
      resumed.llmContext.at(-1)?.content,
      "好的，已确认。任务完成。",
    );
  });
});
