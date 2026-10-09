import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { LlmChunk, LlmRequest } from "../../../src/llm/model/model.js";
import type { LlmAdapter } from "../../../src/llm/adapter/port/llm-adapter.js";
import { CONTENT_REFS_METADATA_KEY } from "../../../src/protocol/content-reference.js";
import type { ContentRef } from "../../../src/protocol/content-reference.js";
import type { PostCompactRestorer } from "../../../src/pipeline/compression/port/content-restoration.js";
import type { ContextCompressor } from "../../../src/pipeline/compression/port/context-compression.js";
import {
  RuntimeContext,
  type RuntimeContextOptions,
} from "../../../src/pipeline/context/runtime-context.js";
import { EVENT_TYPES, type RuntimeEvent } from "../../../src/protocol/event.js";
import type { RawMessage } from "../../../src/protocol/message.js";
import {
  DefaultCompressor,
  formatCompactSummary,
} from "../../../src/pipeline/compression/service/default-context-compressor.js";
import { runReactLoop } from "../../../src/pipeline/react-loop/react-loop.js";
import { NoopToolDispatcher } from "../../../src/tool/dispatcher/service/map-tool-dispatcher.js";

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
  public readonly requests: LlmRequest[] = [];
  readonly #responses: readonly (readonly LlmChunk[])[];

  public constructor(responses: readonly (readonly LlmChunk[])[]) {
    this.#responses = responses;
  }

  public streamCompletion(
    request: LlmRequest,
  ): Promise<AsyncIterable<LlmChunk>> {
    const index = this.requests.length;
    this.requests.push(request);
    return Promise.resolve(stream(this.#responses[index] ?? []));
  }
}

class HangingAdapter implements LlmAdapter {
  public streamCompletion(): Promise<AsyncIterable<LlmChunk>> {
    return Promise.resolve({
      [Symbol.asyncIterator](): AsyncIterator<LlmChunk> {
        return {
          next(): Promise<IteratorResult<LlmChunk>> {
            return new Promise<IteratorResult<LlmChunk>>((): void => {});
          },
        };
      },
    });
  }
}

class RecordingRestorer implements PostCompactRestorer {
  public references = 0;

  public buildAttachments(
    references: readonly ContentRef[],
    _signal: AbortSignal,
  ): Promise<readonly RawMessage[]> {
    this.references = references.length;
    return Promise.resolve([
      { role: "user", content: "【恢复的附件：package.json 内容】" },
    ]);
  }
}

class InjectedCompressor implements ContextCompressor {
  public called = false;

  public shouldCompact(): Promise<boolean> {
    return Promise.resolve(true);
  }

  public compress(): Promise<readonly RawMessage[]> {
    this.called = true;
    return Promise.resolve([{ role: "user", content: "自定义压缩结果" }]);
  }
}

function createContext(
  overrides: Partial<RuntimeContextOptions> = {},
): RuntimeContext {
  return new RuntimeContext({
    sessionId: "session",
    checkpointId: "session",
    userId: "owner",
    requestId: "request",
    traceId: "trace",
    checkpointRevision: 0n,
    fencingToken: 0n,
    messages: [],
    llmContext: [],
    ...overrides,
  });
}

function summaryResponse(): readonly LlmChunk[] {
  return [
    {
      content:
        "<analysis>草稿思考</analysis>\n<summary>\n1. Primary Request: 修复 bug\n8. Current Work: 改 config.ts\n</summary>",
    },
  ];
}

void describe("Runtime TypeScript context compressor", () => {
  void it("extracts the summary and removes analysis scratchpad", () => {
    const formatted = formatCompactSummary(
      "<analysis>草稿</analysis><summary> 关键上下文 </summary>",
    );
    assert.equal(formatted, "Summary:\n关键上下文");
  });

  void it("uses the effective window threshold and disables unknown windows", async () => {
    const adapter = new SequenceAdapter([]);
    const compressor = new DefaultCompressor(
      adapter,
      { enabled: true },
      { contextWindow: 200_000, maxTokens: 20_000 },
    );
    assert.equal(
      await compressor.shouldCompact(
        createContext(),
        [{ role: "user", content: "x".repeat(167_000 * 4) }],
        AbortSignal.timeout(1_000),
      ),
      true,
    );
    assert.equal(
      await compressor.shouldCompact(
        createContext(),
        [{ role: "user", content: "hi" }],
        AbortSignal.timeout(1_000),
      ),
      false,
    );
    assert.equal(
      await new DefaultCompressor(adapter, { enabled: true }, {}).shouldCompact(
        createContext(),
        [{ role: "user", content: "x".repeat(1_000_000) }],
        AbortSignal.timeout(1_000),
      ),
      false,
    );
  });

  void it("opens a circuit after three consecutive summary failures", async () => {
    const adapter = new SequenceAdapter([
      [{ content: null, error: new Error("failed") }],
      [{ content: null, error: new Error("failed") }],
      [{ content: null, error: new Error("failed") }],
    ]);
    const compressor = new DefaultCompressor(
      adapter,
      { enabled: true, triggerThreshold: 1 },
      {},
    );
    const messages: readonly RawMessage[] = [
      { role: "user", content: "history" },
      { role: "user", content: "current" },
    ];
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await assert.rejects(
        compressor.compress(
          createContext(),
          messages,
          AbortSignal.timeout(1_000),
        ),
        /failed/,
      );
    }
    assert.equal(
      await compressor.shouldCompact(
        createContext(),
        messages,
        AbortSignal.timeout(1_000),
      ),
      false,
    );
  });

  void it("honors cancellation while waiting for a summary chunk", async () => {
    const compressor = new DefaultCompressor(
      new HangingAdapter(),
      { enabled: true, idleTimeoutSeconds: 30 },
      {},
    );
    const controller = new AbortController();
    const pending = compressor.compress(
      createContext(),
      [
        { role: "user", content: "history" },
        { role: "user", content: "current" },
      ],
      controller.signal,
    );
    controller.abort(new Error("cancelled"));
    await assert.rejects(pending, /cancelled/);
  });

  void it("preserves structure, restores references, and emits compaction metadata", async () => {
    const adapter = new SequenceAdapter([summaryResponse()]);
    const restorer = new RecordingRestorer();
    const events: RuntimeEvent[] = [];
    const reference: ContentRef = { kind: "file", key: "package.json" };
    const current = { role: "user", content: "继续" } satisfies RawMessage;
    const context = createContext({
      messages: [current],
      metadata: new Map([[CONTENT_REFS_METADATA_KEY, [reference]]]),
      eventSink: (event: RuntimeEvent): void => {
        events.push(event);
      },
    });
    const compressor = new DefaultCompressor(
      adapter,
      { enabled: true, keepRecent: 2, restorer },
      { contextWindow: 200_000 },
    );
    const messages: readonly RawMessage[] = [
      { role: "system", content: "你是助手" },
      { role: "user", content: "早期对话" },
      { role: "assistant", content: "中间对话" },
      { role: "user", content: "最近历史" },
      current,
    ];

    const output = await compressor.compress(
      context,
      messages,
      AbortSignal.timeout(1_000),
    );
    assert.equal(output.length, 7);
    assert.equal(output[0]?.content, "你是助手");
    assert.match(output[1]?.content ?? "", /Conversation compacted/);
    assert.match(output[2]?.content ?? "", /This session is being continued/);
    assert.deepEqual(
      output.slice(3, 6).map((message) => message.content),
      ["中间对话", "最近历史", "继续"],
    );
    assert.equal(output[6]?.content, "【恢复的附件：package.json 内容】");
    assert.equal(restorer.references, 1);
    assert.equal(events[0]?.type, EVENT_TYPES.COMPACTION);
  });

  void it("moves a split point backward to preserve tool-call pairing", async () => {
    const adapter = new SequenceAdapter([summaryResponse()]);
    const compressor = new DefaultCompressor(
      adapter,
      { enabled: true, keepRecent: 1 },
      { contextWindow: 200_000 },
    );
    const current = { role: "user", content: "当前输入" } satisfies RawMessage;
    const output = await compressor.compress(
      createContext({ messages: [current] }),
      [
        { role: "system", content: "system" },
        { role: "user", content: "old" },
        {
          role: "assistant",
          content: null,
          toolCalls: [
            {
              id: "call-1",
              type: "function",
              function: { name: "calc", arguments: "{}" },
            },
          ],
        },
        { role: "tool", content: "result", toolCallId: "call-1" },
        current,
      ],
      AbortSignal.timeout(1_000),
    );

    assert.equal(output.length, 6);
    assert.equal(output[3]?.toolCalls?.[0]?.id, "call-1");
    assert.equal(output[4]?.role, "tool");
    assert.equal(output[5]?.role, "user");
    assert.deepEqual(
      adapter.requests[0]?.messages
        .slice(0, -1)
        .map((message: RawMessage) => message.role),
      ["system", "user"],
    );
  });

  void it("uses an injected compressor and builds the default only when enabled", async () => {
    const injected = new InjectedCompressor();
    const directAdapter = new SequenceAdapter([[{ content: "done" }]]);
    const injectedResult = await runReactLoop({
      context: createContext({
        llmContext: [{ role: "user", content: "old" }],
      }),
      adapter: directAdapter,
      dispatcher: new NoopToolDispatcher(),
      tools: [],
      systemPrompt: "",
      modelParams: {},
      config: { compression: { compressor: injected } },
      signal: AbortSignal.timeout(1_000),
    });
    assert.equal(injected.called, true);
    assert.equal(injectedResult.llmContext[0]?.content, "自定义压缩结果");

    const automaticAdapter = new SequenceAdapter([
      summaryResponse(),
      [{ content: "done" }],
    ]);
    const automaticResult = await runReactLoop({
      context: createContext({
        llmContext: [
          { role: "user", content: "old" },
          { role: "user", content: "current" },
        ],
      }),
      adapter: automaticAdapter,
      dispatcher: new NoopToolDispatcher(),
      tools: [],
      systemPrompt: "",
      modelParams: {},
      config: { compression: { enabled: true, triggerThreshold: 1 } },
      signal: AbortSignal.timeout(1_000),
    });
    assert.equal(automaticAdapter.requests.length, 2);
    assert.match(
      automaticResult.llmContext.map((message) => message.content).join(" "),
      /Conversation compacted/,
    );

    const disabledAdapter = new SequenceAdapter([[{ content: "done" }]]);
    await runReactLoop({
      context: createContext({
        llmContext: [{ role: "user", content: "x".repeat(100) }],
      }),
      adapter: disabledAdapter,
      dispatcher: new NoopToolDispatcher(),
      tools: [],
      systemPrompt: "",
      modelParams: {},
      config: {},
      signal: AbortSignal.timeout(1_000),
    });
    assert.equal(disabledAdapter.requests.length, 1);
  });
});
