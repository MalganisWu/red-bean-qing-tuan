import assert from "node:assert/strict";
import { describe, it } from "node:test";

// Checkpoint Store 参考实现测试与 src/runtime/checkpoint 能力对应。

import {
  CHECKPOINT_STATUSES,
  CONSUME_DISPOSITIONS,
  CheckpointStoreError,
  MemoryCheckpointStore,
  type Checkpoint,
} from "../../../src/runtime/checkpoint/checkpoint.js";
import {
  RUNTIME_ERROR_CODES,
  type RuntimeErrorCode,
} from "../../../src/runtime/run/error/runtime-error.js";

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

function suspendedCheckpoint(
  threadId: string,
  userId: string,
  interruptId: string,
): Checkpoint {
  return {
    ...checkpointFor(threadId, userId, "waiting"),
    status: CHECKPOINT_STATUSES.SUSPENDED,
    interrupt: {
      toolCallId: interruptId,
      toolName: "ask",
      arguments: {},
      payload: { question: "continue?" },
    },
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
  void it("claims, replays, and protects interrupt consumption", async () => {
    const store = new MemoryCheckpointStore((): number => 1234);
    const created = await store.save(
      {
        checkpoint: suspendedCheckpoint("resume", "owner", "call-1"),
        expectedRevision: 0n,
        fencingToken: 0n,
      },
      activeSignal(),
    );
    const request = {
      threadId: "resume",
      userId: "owner",
      interruptId: "call-1",
      requestId: "request-1",
      response: "yes",
      expectedRevision: created.revision,
      fencingToken: 0n,
    };

    const claimed = await store.consumeInterrupt(request, activeSignal());
    assert.equal(claimed.disposition, CONSUME_DISPOSITIONS.CLAIMED);
    assert.equal(claimed.record.revision, 2n);
    assert.deepEqual(claimed.record.checkpoint.resumeClaim, {
      interruptId: "call-1",
      requestId: "request-1",
      response: "yes",
      claimedAt: 1234,
    });

    const inProgress = await store.consumeInterrupt(request, activeSignal());
    assert.equal(inProgress.disposition, CONSUME_DISPOSITIONS.IN_PROGRESS);
    await expectStoreError(
      store.consumeInterrupt({ ...request, response: "no" }, activeSignal()),
      RUNTIME_ERROR_CODES.IDEMPOTENCY_CONFLICT,
    );

    const finalCheckpoint: Checkpoint = {
      ...checkpointFor("resume", "owner", "done"),
      lastResumeInterrupt: "call-1",
    };
    const completed = await store.save(
      {
        checkpoint: finalCheckpoint,
        expectedRevision: claimed.record.revision,
        fencingToken: 0n,
        claimRequestId: "request-1",
      },
      activeSignal(),
    );
    assert.equal(completed.revision, 3n);

    const replayed = await store.consumeInterrupt(request, activeSignal());
    assert.equal(replayed.disposition, CONSUME_DISPOSITIONS.REPLAYED);
    assert.equal(replayed.record.revision, 3n);
    assert.equal(replayed.record.checkpoint.messages[0]?.content, "done");
  });

  void it("rejects deleting an active resume claim", async () => {
    const store = new MemoryCheckpointStore();
    const created = await store.save(
      {
        checkpoint: suspendedCheckpoint("busy", "owner", "call-1"),
        expectedRevision: 0n,
        fencingToken: 0n,
      },
      activeSignal(),
    );
    await store.consumeInterrupt(
      {
        threadId: "busy",
        userId: "owner",
        interruptId: "call-1",
        requestId: "request-1",
        response: "yes",
        expectedRevision: created.revision,
        fencingToken: 0n,
      },
      activeSignal(),
    );

    await expectStoreError(
      store.delete(
        {
          threadId: "busy",
          userId: "owner",
          expectedRevision: 2n,
          fencingToken: 0n,
        },
        activeSignal(),
      ),
      RUNTIME_ERROR_CODES.THREAD_BUSY,
    );

    await expectStoreError(
      store.save(
        {
          checkpoint: checkpointFor("busy", "owner", "stale overwrite"),
          expectedRevision: 2n,
          fencingToken: 0n,
        },
        activeSignal(),
      ),
      RUNTIME_ERROR_CODES.THREAD_BUSY,
    );
    const owner = {
      ...checkpointFor("busy", "owner", "completed"),
      lastResumeInterrupt: "call-1",
    };
    const saved = await store.save(
      {
        checkpoint: owner,
        expectedRevision: 2n,
        fencingToken: 0n,
        claimRequestId: "request-1",
      },
      activeSignal(),
    );
    assert.equal(saved.revision, 3n);
  });

  void it("atomically allows only one distinct interrupt claimant", async () => {
    const store = new MemoryCheckpointStore();
    const created = await store.save(
      {
        checkpoint: suspendedCheckpoint("atomic", "owner", "call-1"),
        expectedRevision: 0n,
        fencingToken: 0n,
      },
      activeSignal(),
    );
    const outcomes = await Promise.allSettled(
      Array.from({ length: 16 }, (_value, index) =>
        store.consumeInterrupt(
          {
            threadId: "atomic",
            userId: "owner",
            interruptId: "call-1",
            requestId: `request-${index}`,
            response: "yes",
            expectedRevision: created.revision,
            fencingToken: 0n,
          },
          activeSignal(),
        ),
      ),
    );
    assert.equal(
      outcomes.filter((outcome) => outcome.status === "fulfilled").length,
      1,
    );
    for (const outcome of outcomes) {
      if (outcome.status === "fulfilled") continue;
      assert.equal(
        outcome.reason instanceof CheckpointStoreError &&
          outcome.reason.code === RUNTIME_ERROR_CODES.RESUME_IN_PROGRESS,
        true,
      );
    }
  });

  void it("returns the requested identity and reserved revision for missing records", async () => {
    const store = new MemoryCheckpointStore();
    const missing = await expectStoreError(
      store.load(
        { threadId: "missing", userId: "owner", fencingToken: 20n },
        activeSignal(),
      ),
      RUNTIME_ERROR_CODES.CHECKPOINT_NOT_FOUND,
    );
    assert.equal(missing.record?.revision, 0n);
    assert.equal(missing.record?.checkpoint.threadId, "missing");
    assert.equal(missing.record?.checkpoint.userId, "owner");
  });
});
