import assert from "node:assert/strict";

import { cloneCheckpoint } from "../../runtime/checkpoint/codec/checkpoint-clone.js";
import { CHECKPOINT_STATUSES } from "../../runtime/checkpoint/checkpoint-status.js";
import {
  CONSUME_DISPOSITIONS,
  type ConsumeInterruptRequest,
} from "../../runtime/checkpoint/store/port/checkpoint-store.js";
import {
  RUNTIME_ERROR_CODES,
  isRuntimeError,
} from "../../runtime/run/error/runtime-error.js";
import {
  expectStoreError,
  firstMessageContent,
  suspendedCheckpoint,
  withMessage,
  type ContractCase,
  type ContractContext,
} from "./contract-support.js";

export function resumeCheckpointStoreCases(): readonly ContractCase[] {
  return [
    {
      name: "consume lifecycle",
      run: async ({ freshStore, signal }: ContractContext): Promise<void> => {
        const store = await freshStore();
        const created = await store.save(
          {
            checkpoint: suspendedCheckpoint("resume", "owner", "call-1"),
            expectedRevision: 0n,
            fencingToken: 0n,
          },
          signal,
        );
        const request: ConsumeInterruptRequest = {
          threadId: "resume",
          userId: "owner",
          interruptId: "call-1",
          requestId: "request-1",
          response: "approved",
          expectedRevision: created.revision,
          fencingToken: 0n,
        };
        const claimed = await store.consumeInterrupt(request, signal);
        assert.equal(claimed.disposition, CONSUME_DISPOSITIONS.CLAIMED);
        assert.equal(claimed.record.revision, created.revision + 1n);
        assert.deepEqual(claimed.record.checkpoint.resumeClaim, {
          interruptId: request.interruptId,
          requestId: request.requestId,
          response: request.response,
          claimedAt: claimed.record.checkpoint.resumeClaim?.claimedAt,
        });
        assert.equal(claimed.record.checkpoint.interrupt, undefined);

        const inProgress = await store.consumeInterrupt(request, signal);
        assert.equal(inProgress.disposition, CONSUME_DISPOSITIONS.IN_PROGRESS);
        assert.equal(inProgress.record.revision, claimed.record.revision);
        await expectStoreError(
          store.consumeInterrupt({ ...request, response: "rejected" }, signal),
          RUNTIME_ERROR_CODES.IDEMPOTENCY_CONFLICT,
        );
        await expectStoreError(
          store.consumeInterrupt(
            { ...request, interruptId: "call-other" },
            signal,
          ),
          RUNTIME_ERROR_CODES.IDEMPOTENCY_CONFLICT,
        );
        const competitor = {
          ...request,
          requestId: "request-2",
          expectedRevision: claimed.record.revision,
        };
        await expectStoreError(
          store.consumeInterrupt(competitor, signal),
          RUNTIME_ERROR_CODES.RESUME_IN_PROGRESS,
        );

        const finalCheckpoint = withMessage(claimed.record.checkpoint, "done");
        finalCheckpoint.resumeClaim = undefined;
        finalCheckpoint.lastResumeInterrupt = request.interruptId;
        finalCheckpoint.status = CHECKPOINT_STATUSES.COMPLETED;
        const completed = await store.save(
          {
            checkpoint: finalCheckpoint,
            expectedRevision: claimed.record.revision,
            fencingToken: 0n,
            claimRequestId: request.requestId,
          },
          signal,
        );
        assert.equal(completed.revision, claimed.record.revision + 1n);
        const replayed = await store.consumeInterrupt(request, signal);
        assert.equal(replayed.disposition, CONSUME_DISPOSITIONS.REPLAYED);
        assert.equal(replayed.record.revision, completed.revision);
        assert.equal(firstMessageContent(replayed.record), "done");
        await expectStoreError(
          store.consumeInterrupt(
            { ...competitor, expectedRevision: completed.revision },
            signal,
          ),
          RUNTIME_ERROR_CODES.INTERRUPT_ALREADY_CONSUMED,
        );
      },
    },
    {
      name: "consume is atomic under contention",
      run: async ({ freshStore, signal }: ContractContext): Promise<void> => {
        const store = await freshStore();
        const created = await store.save(
          {
            checkpoint: suspendedCheckpoint("contended", "", "call-race"),
            expectedRevision: 0n,
            fencingToken: 0n,
          },
          signal,
        );
        const outcomes = await Promise.all(
          Array.from({ length: 16 }, async (_unused, index) => {
            try {
              return {
                result: await store.consumeInterrupt(
                  {
                    threadId: "contended",
                    userId: "",
                    interruptId: "call-race",
                    requestId: `request-${index}`,
                    response: "approved",
                    expectedRevision: created.revision,
                    fencingToken: 0n,
                  },
                  signal,
                ),
              };
            } catch (error: unknown) {
              return { error };
            }
          }),
        );
        let claimed = 0;
        let inProgress = 0;
        for (const outcome of outcomes) {
          if (
            "result" in outcome &&
            outcome.result?.disposition === CONSUME_DISPOSITIONS.CLAIMED
          ) {
            claimed += 1;
          } else if (
            "error" in outcome &&
            isRuntimeError(
              outcome.error,
              RUNTIME_ERROR_CODES.RESUME_IN_PROGRESS,
            )
          ) {
            inProgress += 1;
          } else {
            assert.fail("unexpected contention outcome");
          }
        }
        assert.equal(claimed, 1);
        assert.equal(inProgress, 15);
      },
    },
    {
      name: "final save claim ownership and CAS",
      run: async ({ freshStore, signal }: ContractContext): Promise<void> => {
        const store = await freshStore();
        const created = await store.save(
          {
            checkpoint: suspendedCheckpoint("claim-save", "", "call-final"),
            expectedRevision: 0n,
            fencingToken: 0n,
          },
          signal,
        );
        const claimed = await store.consumeInterrupt(
          {
            threadId: "claim-save",
            userId: "",
            interruptId: "call-final",
            requestId: "claim-owner",
            response: "yes",
            expectedRevision: created.revision,
            fencingToken: 0n,
          },
          signal,
        );
        const finalCheckpoint = cloneCheckpoint(claimed.record.checkpoint);
        finalCheckpoint.resumeClaim = undefined;
        finalCheckpoint.lastResumeInterrupt = "call-final";
        finalCheckpoint.status = CHECKPOINT_STATUSES.COMPLETED;
        const baseRequest = {
          checkpoint: finalCheckpoint,
          expectedRevision: claimed.record.revision,
          fencingToken: 0n,
        };
        await expectStoreError(
          store.save(baseRequest, signal),
          RUNTIME_ERROR_CODES.THREAD_BUSY,
        );
        await expectStoreError(
          store.save({ ...baseRequest, claimRequestId: "not-owner" }, signal),
          RUNTIME_ERROR_CODES.THREAD_BUSY,
        );
        await expectStoreError(
          store.save(
            {
              ...baseRequest,
              checkpoint: {
                ...finalCheckpoint,
                lastResumeInterrupt: "call-other",
              },
              claimRequestId: "claim-owner",
            },
            signal,
          ),
          RUNTIME_ERROR_CODES.THREAD_BUSY,
        );
        await expectStoreError(
          store.save(
            {
              ...baseRequest,
              checkpoint: {
                ...finalCheckpoint,
                resumeClaim: claimed.record.checkpoint.resumeClaim,
              },
              claimRequestId: "claim-owner",
            },
            signal,
          ),
          RUNTIME_ERROR_CODES.THREAD_BUSY,
        );
        await expectStoreError(
          store.save(
            {
              ...baseRequest,
              expectedRevision: created.revision,
              claimRequestId: "claim-owner",
            },
            signal,
          ),
          RUNTIME_ERROR_CODES.REVISION_CONFLICT,
        );
        const completed = await store.save(
          { ...baseRequest, claimRequestId: "claim-owner" },
          signal,
        );
        assert.equal(completed.revision, claimed.record.revision + 1n);
      },
    },
  ];
}
