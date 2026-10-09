import assert from "node:assert/strict";
import { describe, it } from "node:test";

// Runtime Facade 行为测试与 src/runtime 能力目录保持镜像。

import type { LlmChunk, LlmRequest } from "../../../src/llm/model/model.js";
import type { LlmAdapter } from "../../../src/llm/adapter/port/llm-adapter.js";
import {
  CHECKPOINT_STATUSES,
  MemoryCheckpointStore,
  parseCheckpoint,
  serializeCheckpoint,
} from "../../../src/runtime/checkpoint/checkpoint.js";
import {
  AgentRuntime,
  EVENT_SINK_ERROR_POLICIES,
  RuntimeExecutionError,
  serializeRuntimeResult,
  type EventSink,
} from "../../../src/runtime/public-api.js";
import type { RuntimeEvent } from "../../../src/protocol/event.js";
import type { Tool, ToolResult } from "../../../src/tool/definition/tool.js";

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
  #index = 0;

  public constructor(responses: readonly (readonly LlmChunk[])[]) {
    this.#responses = responses;
  }

  public streamCompletion(
    request: LlmRequest,
    _signal: AbortSignal,
  ): Promise<AsyncIterable<LlmChunk>> {
    this.requests.push(request);
    const response = this.#responses[this.#index] ?? [];
    this.#index += 1;
    return Promise.resolve(stream(response));
  }
}

class PreserveTool implements Tool {
  public readonly name = "preserve";
  public readonly schema = {
    type: "function",
    function: { name: "preserve", description: "", parameters: {} },
  };

  public execute(): Promise<ToolResult> {
    return Promise.resolve({
      content: "saved",
      preserve: {
        kind: "object",
        key: "docs/1",
        version: "v1",
        meta: { bucket: "agent" },
      },
    });
  }
}

function call(name: string, id: string): LlmChunk {
  return {
    content: null,
    toolCalls: [
      {
        id,
        type: "function",
        function: { name, arguments: "{}" },
      },
    ],
  };
}

void describe("Runtime TypeScript high-level facade", () => {
  void it("carries tool content references into the saved checkpoint", async () => {
    const store = new MemoryCheckpointStore();
    const runtime = new AgentRuntime({
      model: new SequenceAdapter([
        [call("preserve", "call-1")],
        [{ content: "done" }],
      ]),
      tools: [new PreserveTool()],
      checkpointStore: store,
    });

    const result = await runtime.run(
      { threadId: "refs", input: "start" },
      AbortSignal.timeout(1_000),
    );
    assert.equal(result.checkpoint.contentRefs[0]?.key, "docs/1");
    const saved = await store.load(
      { threadId: "refs", userId: "", fencingToken: 0n },
      AbortSignal.timeout(1_000),
    );
    assert.equal(saved.checkpoint.contentRefs[0]?.version, "v1");
  });

  void it("serializes stable snake-case fields and deep-copies content references", async () => {
    const metadata: Record<string, string> = { bucket: "agent" };
    const checkpoint = {
      version: 1,
      threadId: "thread-json",
      userId: "",
      status: CHECKPOINT_STATUSES.SUSPENDED,
      messages: [],
      contentRefs: [
        {
          kind: "object",
          key: "docs/1",
          meta: metadata,
          fetch: (): Promise<Uint8Array> =>
            Promise.resolve(new Uint8Array([1])),
        },
      ],
      interrupt: {
        toolCallId: "call-1",
        toolName: "ask",
        arguments: {},
        payload: {},
      },
      lastResumeInterrupt: "",
      tokensUsed: 0,
      finishReason: "",
    };
    const encoded = JSON.stringify(
      serializeRuntimeResult({
        status: CHECKPOINT_STATUSES.SUSPENDED,
        output: "",
        messages: [],
        interrupt: checkpoint.interrupt,
        tokensUsed: 0,
        finishReason: "",
        checkpoint,
        revision: 2n,
      }),
    );

    const store = new MemoryCheckpointStore();
    await store.save(
      { checkpoint, expectedRevision: 0n, fencingToken: 0n },
      AbortSignal.timeout(1_000),
    );
    metadata["bucket"] = "mutated";
    const loaded = await store.load(
      { threadId: "thread-json", userId: "", fencingToken: 0n },
      AbortSignal.timeout(1_000),
    );
    assert.equal(loaded.checkpoint.contentRefs[0]?.meta?.["bucket"], "agent");

    for (const field of [
      '"checkpoint"',
      '"thread_id"',
      '"tool_call_id"',
      '"tool_name"',
      '"content_refs"',
    ]) {
      assert.match(encoded, new RegExp(field));
    }
    assert.doesNotMatch(encoded, /threadId|toolCallId|finishReason|fetch/);
    const restored = parseCheckpoint(serializeCheckpoint(checkpoint));
    assert.equal(restored.threadId, checkpoint.threadId);
    assert.deepEqual(restored.messages, checkpoint.messages);
    assert.equal(restored.interrupt?.toolCallId, "call-1");
    assert.equal(restored.contentRefs[0]?.key, "docs/1");
  });

  void it("fails fast on event sink errors by default and can explicitly ignore them", async () => {
    const failingSink: EventSink = {
      publish: (_event: RuntimeEvent): void => {
        throw new Error("sink unavailable");
      },
    };
    const failFast = new AgentRuntime({
      model: new SequenceAdapter([[{ content: "answer" }]]),
      eventSink: failingSink,
    });
    await assert.rejects(
      failFast.run({ input: "start" }, AbortSignal.timeout(1_000)),
      (error: unknown): boolean =>
        error instanceof RuntimeExecutionError &&
        error.result.status === CHECKPOINT_STATUSES.FAILED &&
        /sink unavailable/i.test(error.message),
    );

    const ignore = new AgentRuntime({
      model: new SequenceAdapter([[{ content: "answer" }]]),
      eventSink: failingSink,
      eventSinkErrorPolicy: EVENT_SINK_ERROR_POLICIES.IGNORE,
    });
    const result = await ignore.run(
      { input: "start" },
      AbortSignal.timeout(1_000),
    );
    assert.equal(result.status, CHECKPOINT_STATUSES.COMPLETED);
    assert.equal(result.output, "answer");
  });
});
