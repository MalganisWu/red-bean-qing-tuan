import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { LlmChunk } from "../../../src/llm/model/model.js";
import { HookFatalError } from "../../../src/pipeline/hook/hook-error.js";
import type { MessageHook } from "../../../src/pipeline/hook/port/message-hook.js";
import type { RawMessage } from "../../../src/protocol/message.js";
import {
  CompositeMessageHook,
  MessageBufferCheckpointer,
  type MessageAppender,
} from "../../../src/pipeline/hook/service/composite-message-hook.js";
import { normalizeChunk } from "../../../src/pipeline/react-loop/message-normalizer.js";
import { estimateTokens } from "../../../src/pipeline/compression/token-counter.js";
import { RuntimeContext } from "../../../src/pipeline/context/runtime-context.js";

function newContext(): RuntimeContext {
  return new RuntimeContext({
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
}

class UserHook implements MessageHook {
  readonly #calls: string[];
  readonly #error: Error | undefined;
  readonly #name: string;

  public constructor(name: string, calls: string[], error?: Error) {
    this.#name = name;
    this.#calls = calls;
    this.#error = error;
  }

  public onUserMessage(): Promise<void> {
    this.#calls.push(this.#name);
    return this.#error ? Promise.reject(this.#error) : Promise.resolve();
  }

  public onAssistantMessage(): Promise<void> {
    return Promise.resolve();
  }

  public onToolMessage(): Promise<void> {
    return Promise.resolve();
  }
}

void describe("Runtime TypeScript pipeline helpers", () => {
  void it("normalizes reasoning and content while ignoring empty chunks", () => {
    const clock = (): number => 1234;
    const both: LlmChunk = {
      content: "answer",
      reasoningContent: "thinking",
    };

    assert.deepEqual(normalizeChunk(both, 2, clock), [
      { type: "reason", content: "thinking", step: 2, timestamp: 1234 },
      { type: "token", content: "answer" },
    ]);
    assert.deepEqual(normalizeChunk({ content: null }, 1, clock), []);
    assert.deepEqual(normalizeChunk({ content: "" }, 1, clock), []);
  });

  void it("runs every message hook and gives fatal errors priority", async () => {
    const calls: string[] = [];
    const fatalCause = new Error("fatal");
    const hook = new CompositeMessageHook([
      new UserHook("ordinary", calls, new Error("ordinary")),
      new UserHook("fatal", calls, new HookFatalError(fatalCause)),
      new UserHook("last", calls),
    ]);

    await assert.rejects(
      hook.onUserMessage(
        newContext(),
        { role: "user", content: "hello" },
        AbortSignal.timeout(1_000),
      ),
      (error: unknown): boolean => error instanceof HookFatalError,
    );
    assert.deepEqual(calls, ["ordinary", "fatal", "last"]);
  });

  void it("estimates ASCII and non-ASCII message and tool-call tokens", () => {
    const messages: readonly RawMessage[] = [
      { role: "user", content: "abcdefgh" },
      { role: "assistant", content: "你好" },
      {
        role: "assistant",
        content: null,
        toolCalls: [
          {
            id: "call-1",
            type: "function",
            function: { name: "time", arguments: '{"x":"中文"}' },
          },
        ],
      },
    ];

    assert.equal(estimateTokens(messages), 9);
  });

  void it("bounds message buffer writes independently of request cancellation", async () => {
    const appender: MessageAppender = {
      append: (
        _key: string,
        _message: RawMessage,
        signal: AbortSignal,
      ): Promise<void> =>
        new Promise<void>((_resolve, reject): void => {
          signal.addEventListener(
            "abort",
            (): void => reject(new Error("append timed out")),
            { once: true },
          );
        }),
    };
    const hook = new MessageBufferCheckpointer(appender, 10);

    await assert.rejects(
      hook.onAssistantMessage(
        newContext(),
        { role: "assistant", content: "partial" },
        AbortSignal.abort(new Error("request cancelled")),
      ),
      /timeout/i,
    );
  });
});
