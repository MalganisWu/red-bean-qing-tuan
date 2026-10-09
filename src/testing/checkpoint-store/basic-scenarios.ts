import assert from "node:assert/strict";

import { RUNTIME_ERROR_CODES } from "../../runtime/run/error/runtime-error.js";
import {
  checkpointFor,
  expectStoreError,
  firstMessageContent,
  withMessage,
  type ContractCase,
  type ContractContext,
} from "./contract-support.js";

export function basicCheckpointStoreCases(): readonly ContractCase[] {
  return [
    {
      name: "CAS",
      run: async ({ freshStore, signal }: ContractContext): Promise<void> => {
        const store = await freshStore();
        const first = checkpointFor("cas", "owner", "first");
        const created = await store.save(
          { checkpoint: first, expectedRevision: 0n, fencingToken: 0n },
          signal,
        );
        assert.equal(created.revision, 1n);
        const second = withMessage(first, "second");
        const updated = await store.save(
          {
            checkpoint: second,
            expectedRevision: created.revision,
            fencingToken: 0n,
          },
          signal,
        );
        assert.equal(updated.revision, 2n);
        await expectStoreError(
          store.save(
            {
              checkpoint: withMessage(first, "stale"),
              expectedRevision: created.revision,
              fencingToken: 0n,
            },
            signal,
          ),
          RUNTIME_ERROR_CODES.REVISION_CONFLICT,
        );
        const loaded = await store.load(
          { threadId: "cas", userId: "owner", fencingToken: 0n },
          signal,
        );
        assert.equal(loaded.revision, updated.revision);
        assert.equal(firstMessageContent(loaded), "second");
      },
    },
    {
      name: "missing record returns requested identity",
      run: async ({ freshStore, signal }: ContractContext): Promise<void> => {
        const store = await freshStore();
        const error = await expectStoreError(
          store.load(
            { threadId: "missing", userId: "owner", fencingToken: 0n },
            signal,
          ),
          RUNTIME_ERROR_CODES.CHECKPOINT_NOT_FOUND,
        );
        assert.equal(error.record?.revision, 0n);
        assert.equal(error.record?.checkpoint.threadId, "missing");
        assert.equal(error.record?.checkpoint.userId, "owner");
      },
    },
    {
      name: "owner mismatch",
      run: async ({ freshStore, signal }: ContractContext): Promise<void> => {
        const store = await freshStore();
        const created = await store.save(
          {
            checkpoint: checkpointFor("owned", "alice", "private"),
            expectedRevision: 0n,
            fencingToken: 0n,
          },
          signal,
        );
        const denied = await expectStoreError(
          store.load(
            { threadId: "owned", userId: "bob", fencingToken: 99n },
            signal,
          ),
          RUNTIME_ERROR_CODES.CHECKPOINT_NOT_FOUND,
        );
        assert.equal(denied.record, undefined);
        await expectStoreError(
          store.save(
            {
              checkpoint: checkpointFor("owned", "bob", "overwrite"),
              expectedRevision: created.revision,
              fencingToken: 0n,
            },
            signal,
          ),
          RUNTIME_ERROR_CODES.CHECKPOINT_NOT_FOUND,
        );
        await expectStoreError(
          store.consumeInterrupt(
            {
              threadId: "owned",
              userId: "bob",
              interruptId: "missing",
              requestId: "bob-resume",
              response: "yes",
              expectedRevision: created.revision,
              fencingToken: 0n,
            },
            signal,
          ),
          RUNTIME_ERROR_CODES.CHECKPOINT_NOT_FOUND,
        );
        await expectStoreError(
          store.delete(
            {
              threadId: "owned",
              userId: "bob",
              expectedRevision: created.revision,
              fencingToken: 0n,
            },
            signal,
          ),
          RUNTIME_ERROR_CODES.CHECKPOINT_NOT_FOUND,
        );
        const loaded = await store.load(
          { threadId: "owned", userId: "alice", fencingToken: 0n },
          signal,
        );
        assert.equal(loaded.revision, created.revision);
        assert.equal(firstMessageContent(loaded), "private");
      },
    },
  ];
}
