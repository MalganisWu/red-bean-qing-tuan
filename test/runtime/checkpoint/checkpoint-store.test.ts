import assert from "node:assert/strict";
import { describe, it } from "node:test";

// Checkpoint Store 参考实现测试与 src/runtime/checkpoint 能力对应。

import {
  CHECKPOINT_STATUSES,
  CheckpointStoreError,
  MemoryCheckpointStore,
  type Checkpoint,
  type CheckpointRecord,
  type CheckpointStore,
  type ConsumeInterruptRequest,
  type ConsumeInterruptResult,
  type DeleteCheckpointRequest,
  type LoadCheckpointRequest,
  type SaveCheckpointRequest,
} from "../../../src/runtime/checkpoint/checkpoint.js";
import {
  RUNTIME_ERROR_CODES,
  RuntimeError,
  type RuntimeErrorCode,
} from "../../../src/runtime/run/error/runtime-error.js";

function unsupportedFence<TOutput>(fencingToken: bigint): Promise<TOutput> {
  if (fencingToken !== 0n) {
    return Promise.reject(
      new RuntimeError(RUNTIME_ERROR_CODES.FENCING_UNSUPPORTED),
    );
  }
  return Promise.reject(new Error("test wrapper requires a fencing token"));
}

class NonFencingStore implements CheckpointStore {
  readonly #next = new MemoryCheckpointStore();

  public load(
    request: LoadCheckpointRequest,
    signal: AbortSignal,
  ): Promise<CheckpointRecord> {
    return request.fencingToken === 0n
      ? this.#next.load(request, signal)
      : unsupportedFence(request.fencingToken);
  }

  public save(
    request: SaveCheckpointRequest,
    signal: AbortSignal,
  ): Promise<CheckpointRecord> {
    return request.fencingToken === 0n
      ? this.#next.save(request, signal)
      : unsupportedFence(request.fencingToken);
  }

  public consumeInterrupt(
    request: ConsumeInterruptRequest,
    signal: AbortSignal,
  ): Promise<ConsumeInterruptResult> {
    return request.fencingToken === 0n
      ? this.#next.consumeInterrupt(request, signal)
      : unsupportedFence(request.fencingToken);
  }

  public delete(
    request: DeleteCheckpointRequest,
    signal: AbortSignal,
  ): Promise<bigint> {
    return request.fencingToken === 0n
      ? this.#next.delete(request, signal)
      : unsupportedFence(request.fencingToken);
  }
}

function checkpointFor(
  threadId: string,
  userId: string,
  content: string,
): Checkpoint {
  return {
    version: 1,
    threadId,
    userId,
    status: CHECKPOINT_STATUSES.COMPLETED,
    messages: [{ role: "assistant", content }],
    contentRefs: [],
    lastResumeInterrupt: "",
    tokensUsed: 0,
    finishReason: "stop",
  };
}

async function expectStoreError(
  operation: Promise<unknown>,
  code: RuntimeErrorCode,
): Promise<CheckpointStoreError> {
  try {
    await operation;
  } catch (error: unknown) {
    assert.equal(error instanceof CheckpointStoreError, true);
    if (!(error instanceof CheckpointStoreError)) throw error;
    assert.equal(error.code, code);
    return error;
  }
  assert.fail(`expected checkpoint error ${code}`);
}

const activeSignal = (): AbortSignal => AbortSignal.timeout(1_000);

void describe("Runtime TypeScript MemoryCheckpointStore", () => {
  void it("supports fail-closed stores without fencing", async () => {
    const store = new NonFencingStore();
    const signal = activeSignal();
    const operations: readonly Promise<unknown>[] = [
      store.load(
        { threadId: "unsupported", userId: "", fencingToken: 1n },
        signal,
      ),
      store.save(
        {
          checkpoint: checkpointFor("unsupported", "", "state"),
          expectedRevision: 0n,
          fencingToken: 1n,
        },
        signal,
      ),
      store.consumeInterrupt(
        {
          threadId: "unsupported",
          userId: "",
          interruptId: "call",
          requestId: "request",
          response: "yes",
          expectedRevision: 0n,
          fencingToken: 1n,
        },
        signal,
      ),
      store.delete(
        {
          threadId: "unsupported",
          userId: "",
          expectedRevision: 0n,
          fencingToken: 1n,
        },
        signal,
      ),
    ];

    for (const operation of operations) {
      await assert.rejects(
        operation,
        (error: unknown): boolean =>
          error instanceof RuntimeError &&
          error.code === RUNTIME_ERROR_CODES.FENCING_UNSUPPORTED,
      );
    }
  });

  void it("enforces CAS and returns defensive copies", async () => {
    const store = new MemoryCheckpointStore();
    const source = checkpointFor("cas", "owner", "first");
    const created = await store.save(
      { checkpoint: source, expectedRevision: 0n, fencingToken: 0n },
      activeSignal(),
    );
    assert.equal(created.revision, 1n);

    source.messages[0] = { role: "assistant", content: "mutated input" };
    created.checkpoint.messages[0] = {
      role: "assistant",
      content: "mutated output",
    };
    const unchanged = await store.load(
      { threadId: "cas", userId: "owner", fencingToken: 0n },
      activeSignal(),
    );
    assert.equal(unchanged.checkpoint.messages[0]?.content, "first");

    const updated = await store.save(
      {
        checkpoint: checkpointFor("cas", "owner", "second"),
        expectedRevision: 1n,
        fencingToken: 0n,
      },
      activeSignal(),
    );
    assert.equal(updated.revision, 2n);
    await expectStoreError(
      store.save(
        {
          checkpoint: checkpointFor("cas", "owner", "stale"),
          expectedRevision: 1n,
          fencingToken: 0n,
        },
        activeSignal(),
      ),
      RUNTIME_ERROR_CODES.REVISION_CONFLICT,
    );
  });

  void it("does not reveal records to a different owner", async () => {
    const store = new MemoryCheckpointStore();
    await store.save(
      {
        checkpoint: checkpointFor("owned", "alice", "private"),
        expectedRevision: 0n,
        fencingToken: 0n,
      },
      activeSignal(),
    );

    const denied = await expectStoreError(
      store.load(
        { threadId: "owned", userId: "bob", fencingToken: 99n },
        activeSignal(),
      ),
      RUNTIME_ERROR_CODES.CHECKPOINT_NOT_FOUND,
    );
    assert.equal(denied.record, undefined);
    const loaded = await store.load(
      { threadId: "owned", userId: "alice", fencingToken: 0n },
      activeSignal(),
    );
    assert.equal(loaded.checkpoint.messages[0]?.content, "private");
  });

  void it("retains fencing high-water marks across failed CAS and delete", async () => {
    const store = new MemoryCheckpointStore();
    const created = await store.save(
      {
        checkpoint: checkpointFor("fenced", "owner", "v1"),
        expectedRevision: 0n,
        fencingToken: 10n,
      },
      activeSignal(),
    );

    await expectStoreError(
      store.save(
        {
          checkpoint: checkpointFor("fenced", "owner", "lost-race"),
          expectedRevision: 0n,
          fencingToken: 11n,
        },
        activeSignal(),
      ),
      RUNTIME_ERROR_CODES.REVISION_CONFLICT,
    );
    await expectStoreError(
      store.save(
        {
          checkpoint: checkpointFor("fenced", "owner", "stale-owner"),
          expectedRevision: created.revision,
          fencingToken: 10n,
        },
        activeSignal(),
      ),
      RUNTIME_ERROR_CODES.STALE_FENCE,
    );

    const updated = await store.save(
      {
        checkpoint: checkpointFor("fenced", "owner", "v2"),
        expectedRevision: created.revision,
        fencingToken: 11n,
      },
      activeSignal(),
    );
    const deletedRevision = await store.delete(
      {
        threadId: "fenced",
        userId: "owner",
        expectedRevision: updated.revision,
        fencingToken: 12n,
      },
      activeSignal(),
    );
    assert.equal(deletedRevision, 3n);

    const tombstone = await expectStoreError(
      store.load(
        { threadId: "fenced", userId: "owner", fencingToken: 13n },
        activeSignal(),
      ),
      RUNTIME_ERROR_CODES.CHECKPOINT_NOT_FOUND,
    );
    assert.equal(tombstone.record?.revision, deletedRevision);
    await expectStoreError(
      store.save(
        {
          checkpoint: checkpointFor("fenced", "owner", "stale rebuild"),
          expectedRevision: deletedRevision,
          fencingToken: 12n,
        },
        activeSignal(),
      ),
      RUNTIME_ERROR_CODES.STALE_FENCE,
    );
    const rebuilt = await store.save(
      {
        checkpoint: checkpointFor("fenced", "owner", "rebuilt"),
        expectedRevision: deletedRevision,
        fencingToken: 13n,
      },
      activeSignal(),
    );
    assert.equal(rebuilt.revision, 4n);
  });
});
