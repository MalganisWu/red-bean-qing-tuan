import assert from "node:assert/strict";

import {
  CONSUME_DISPOSITIONS,
  type ConsumeInterruptRequest,
} from "../../runtime/checkpoint/store/port/checkpoint-store.js";
import { RUNTIME_ERROR_CODES } from "../../runtime/run/error/runtime-error.js";
import {
  checkpointFor,
  expectStoreError,
  suspendedCheckpoint,
  withMessage,
  type ContractCase,
  type ContractContext,
} from "./contract-support.js";

export function fencingMutationCases(): readonly ContractCase[] {
  return [
    {
      name: "fencing/consume and delete recheck fence atomically",
      run: async ({ freshStore, signal }: ContractContext): Promise<void> => {
        const consumeStore = await freshStore();
        const created = await consumeStore.save(
          {
            checkpoint: suspendedCheckpoint(
              "consume-fence",
              "owner",
              "call-fence",
            ),
            expectedRevision: 0n,
            fencingToken: 70n,
          },
          signal,
        );
        await consumeStore.load(
          {
            threadId: "consume-fence",
            userId: "owner",
            fencingToken: 71n,
          },
          signal,
        );
        const consumeRequest: ConsumeInterruptRequest = {
          threadId: "consume-fence",
          userId: "owner",
          interruptId: "call-fence",
          requestId: "consume-fence-request",
          response: "yes",
          expectedRevision: created.revision,
          fencingToken: 70n,
        };
        await expectStoreError(
          consumeStore.consumeInterrupt(consumeRequest, signal),
          RUNTIME_ERROR_CODES.STALE_FENCE,
        );
        const claimed = await consumeStore.consumeInterrupt(
          { ...consumeRequest, fencingToken: 71n },
          signal,
        );
        assert.equal(claimed.disposition, CONSUME_DISPOSITIONS.CLAIMED);
        assert.equal(claimed.record.revision, created.revision + 1n);

        const deleteStore = await freshStore();
        const deleteCreated = await deleteStore.save(
          {
            checkpoint: checkpointFor("delete-fence", "owner", "state"),
            expectedRevision: 0n,
            fencingToken: 80n,
          },
          signal,
        );
        await deleteStore.load(
          {
            threadId: "delete-fence",
            userId: "owner",
            fencingToken: 81n,
          },
          signal,
        );
        await expectStoreError(
          deleteStore.delete(
            {
              threadId: "delete-fence",
              userId: "owner",
              expectedRevision: deleteCreated.revision,
              fencingToken: 80n,
            },
            signal,
          ),
          RUNTIME_ERROR_CODES.STALE_FENCE,
        );
        const deletedRevision = await deleteStore.delete(
          {
            threadId: "delete-fence",
            userId: "owner",
            expectedRevision: deleteCreated.revision,
            fencingToken: 81n,
          },
          signal,
        );
        assert.equal(deletedRevision, deleteCreated.revision + 1n);
      },
    },
    {
      name: "fencing/wrong owner mutations cannot advance fence",
      run: async ({ freshStore, signal }: ContractContext): Promise<void> => {
        const saveStore = await freshStore();
        const saveCheckpoint = checkpointFor(
          "wrong-save-fence",
          "alice",
          "state",
        );
        const saveCreated = await saveStore.save(
          {
            checkpoint: saveCheckpoint,
            expectedRevision: 0n,
            fencingToken: 90n,
          },
          signal,
        );
        await expectStoreError(
          saveStore.save(
            {
              checkpoint: checkpointFor("wrong-save-fence", "bob", "wrong"),
              expectedRevision: saveCreated.revision,
              fencingToken: 99n,
            },
            signal,
          ),
          RUNTIME_ERROR_CODES.CHECKPOINT_NOT_FOUND,
        );
        await saveStore.save(
          {
            checkpoint: withMessage(saveCheckpoint, "still alice"),
            expectedRevision: saveCreated.revision,
            fencingToken: 90n,
          },
          signal,
        );

        const consumeStore = await freshStore();
        const consumeCreated = await consumeStore.save(
          {
            checkpoint: suspendedCheckpoint(
              "wrong-consume-fence",
              "alice",
              "call",
            ),
            expectedRevision: 0n,
            fencingToken: 90n,
          },
          signal,
        );
        const consumeBase: ConsumeInterruptRequest = {
          threadId: "wrong-consume-fence",
          userId: "bob",
          interruptId: "call",
          requestId: "wrong",
          response: "yes",
          expectedRevision: consumeCreated.revision,
          fencingToken: 99n,
        };
        await expectStoreError(
          consumeStore.consumeInterrupt(consumeBase, signal),
          RUNTIME_ERROR_CODES.CHECKPOINT_NOT_FOUND,
        );
        await consumeStore.consumeInterrupt(
          {
            ...consumeBase,
            userId: "alice",
            requestId: "owner",
            fencingToken: 90n,
          },
          signal,
        );

        const deleteStore = await freshStore();
        const deleteCreated = await deleteStore.save(
          {
            checkpoint: checkpointFor("wrong-delete-fence", "alice", "state"),
            expectedRevision: 0n,
            fencingToken: 90n,
          },
          signal,
        );
        await expectStoreError(
          deleteStore.delete(
            {
              threadId: "wrong-delete-fence",
              userId: "bob",
              expectedRevision: deleteCreated.revision,
              fencingToken: 99n,
            },
            signal,
          ),
          RUNTIME_ERROR_CODES.CHECKPOINT_NOT_FOUND,
        );
        await deleteStore.delete(
          {
            threadId: "wrong-delete-fence",
            userId: "alice",
            expectedRevision: deleteCreated.revision,
            fencingToken: 90n,
          },
          signal,
        );
      },
    },
  ];
}
