import assert from "node:assert/strict";

import { RUNTIME_ERROR_CODES } from "../../runtime/run/error/runtime-error.js";
import {
  checkpointFor,
  expectStoreError,
  withMessage,
  type ContractCase,
  type ContractContext,
} from "./contract-support.js";

export function fencingHighWaterCases(): readonly ContractCase[] {
  return [
    {
      name: "fencing/zero equal higher lower and downgrade",
      run: async ({ freshStore, signal }: ContractContext): Promise<void> => {
        const store = await freshStore();
        const zero = checkpointFor("unfenced", "", "zero");
        const createdZero = await store.save(
          { checkpoint: zero, expectedRevision: 0n, fencingToken: 0n },
          signal,
        );
        await store.save(
          {
            checkpoint: withMessage(zero, "zero-update"),
            expectedRevision: createdZero.revision,
            fencingToken: 0n,
          },
          signal,
        );
        const checkpoint = checkpointFor("fenced", "", "ten");
        const created = await store.save(
          { checkpoint, expectedRevision: 0n, fencingToken: 10n },
          signal,
        );
        const equal = await store.save(
          {
            checkpoint: withMessage(checkpoint, "equal"),
            expectedRevision: created.revision,
            fencingToken: 10n,
          },
          signal,
        );
        const loaded = await store.load(
          { threadId: "fenced", userId: "", fencingToken: 11n },
          signal,
        );
        assert.equal(loaded.revision, equal.revision);
        await expectStoreError(
          store.save(
            {
              checkpoint: withMessage(checkpoint, "lower"),
              expectedRevision: equal.revision,
              fencingToken: 10n,
            },
            signal,
          ),
          RUNTIME_ERROR_CODES.STALE_FENCE,
        );
        await expectStoreError(
          store.load(
            { threadId: "fenced", userId: "", fencingToken: 10n },
            signal,
          ),
          RUNTIME_ERROR_CODES.STALE_FENCE,
        );
        await expectStoreError(
          store.load(
            { threadId: "fenced", userId: "", fencingToken: 0n },
            signal,
          ),
          RUNTIME_ERROR_CODES.STALE_FENCE,
        );
        const higher = await store.save(
          {
            checkpoint: withMessage(checkpoint, "higher"),
            expectedRevision: equal.revision,
            fencingToken: 12n,
          },
          signal,
        );
        assert.equal(higher.revision, equal.revision + 1n);
      },
    },
    {
      name: "fencing/high token load reserves missing thread",
      run: async ({ freshStore, signal }: ContractContext): Promise<void> => {
        const store = await freshStore();
        const reserved = await expectStoreError(
          store.load(
            { threadId: "reserved", userId: "owner", fencingToken: 20n },
            signal,
          ),
          RUNTIME_ERROR_CODES.CHECKPOINT_NOT_FOUND,
        );
        assert.equal(reserved.record?.revision, 0n);
        assert.equal(reserved.record?.checkpoint.threadId, "reserved");
        assert.equal(reserved.record?.checkpoint.userId, "owner");
        await expectStoreError(
          store.load(
            { threadId: "reserved", userId: "other", fencingToken: 20n },
            signal,
          ),
          RUNTIME_ERROR_CODES.CHECKPOINT_NOT_FOUND,
        );
        await expectStoreError(
          store.save(
            {
              checkpoint: checkpointFor("reserved", "other", "wrong owner"),
              expectedRevision: 0n,
              fencingToken: 20n,
            },
            signal,
          ),
          RUNTIME_ERROR_CODES.CHECKPOINT_NOT_FOUND,
        );
        const checkpoint = checkpointFor("reserved", "owner", "reserved");
        await expectStoreError(
          store.save(
            { checkpoint, expectedRevision: 0n, fencingToken: 19n },
            signal,
          ),
          RUNTIME_ERROR_CODES.STALE_FENCE,
        );
        await expectStoreError(
          store.save(
            { checkpoint, expectedRevision: 0n, fencingToken: 0n },
            signal,
          ),
          RUNTIME_ERROR_CODES.STALE_FENCE,
        );
        const created = await store.save(
          { checkpoint, expectedRevision: 0n, fencingToken: 20n },
          signal,
        );
        assert.equal(created.revision, 1n);
      },
    },
    {
      name: "fencing/higher token survives failed CAS",
      run: async ({ freshStore, signal }: ContractContext): Promise<void> => {
        const store = await freshStore();
        const checkpoint = checkpointFor("takeover", "", "old");
        const created = await store.save(
          { checkpoint, expectedRevision: 0n, fencingToken: 30n },
          signal,
        );
        await expectStoreError(
          store.save(
            { checkpoint, expectedRevision: 0n, fencingToken: 31n },
            signal,
          ),
          RUNTIME_ERROR_CODES.REVISION_CONFLICT,
        );
        await expectStoreError(
          store.save(
            {
              checkpoint,
              expectedRevision: created.revision,
              fencingToken: 30n,
            },
            signal,
          ),
          RUNTIME_ERROR_CODES.STALE_FENCE,
        );
        await store.save(
          {
            checkpoint: withMessage(checkpoint, "new owner"),
            expectedRevision: created.revision,
            fencingToken: 31n,
          },
          signal,
        );
      },
    },
    {
      name: "fencing/wrong owner cannot advance fence",
      run: async ({ freshStore, signal }: ContractContext): Promise<void> => {
        const store = await freshStore();
        const checkpoint = checkpointFor("owner-fence", "alice", "private");
        const created = await store.save(
          { checkpoint, expectedRevision: 0n, fencingToken: 50n },
          signal,
        );
        await expectStoreError(
          store.load(
            { threadId: "owner-fence", userId: "bob", fencingToken: 99n },
            signal,
          ),
          RUNTIME_ERROR_CODES.CHECKPOINT_NOT_FOUND,
        );
        await store.save(
          {
            checkpoint: withMessage(checkpoint, "still owner"),
            expectedRevision: created.revision,
            fencingToken: 50n,
          },
          signal,
        );
      },
    },
    {
      name: "fencing/tombstone retains fence high water",
      run: async ({ freshStore, signal }: ContractContext): Promise<void> => {
        const store = await freshStore();
        const checkpoint = checkpointFor("fenced-delete", "owner", "before");
        const created = await store.save(
          { checkpoint, expectedRevision: 0n, fencingToken: 60n },
          signal,
        );
        const deletedRevision = await store.delete(
          {
            threadId: "fenced-delete",
            userId: "owner",
            expectedRevision: created.revision,
            fencingToken: 60n,
          },
          signal,
        );
        const tombstone = await expectStoreError(
          store.load(
            {
              threadId: "fenced-delete",
              userId: "owner",
              fencingToken: 61n,
            },
            signal,
          ),
          RUNTIME_ERROR_CODES.CHECKPOINT_NOT_FOUND,
        );
        assert.equal(tombstone.record?.revision, deletedRevision);
        await expectStoreError(
          store.save(
            {
              checkpoint,
              expectedRevision: deletedRevision,
              fencingToken: 60n,
            },
            signal,
          ),
          RUNTIME_ERROR_CODES.STALE_FENCE,
        );
        await expectStoreError(
          store.save(
            {
              checkpoint,
              expectedRevision: deletedRevision,
              fencingToken: 0n,
            },
            signal,
          ),
          RUNTIME_ERROR_CODES.STALE_FENCE,
        );
        await store.save(
          {
            checkpoint,
            expectedRevision: deletedRevision,
            fencingToken: 61n,
          },
          signal,
        );
      },
    },
  ];
}
