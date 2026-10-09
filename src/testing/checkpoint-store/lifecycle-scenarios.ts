import assert from "node:assert/strict";

import { cloneCheckpoint } from "../../runtime/checkpoint/codec/checkpoint-clone.js";
import { CHECKPOINT_STATUSES } from "../../runtime/checkpoint/checkpoint-status.js";
import type { Checkpoint } from "../../runtime/checkpoint/model/checkpoint.js";
import {
  CONSUME_DISPOSITIONS,
  type ConsumeInterruptRequest,
} from "../../runtime/checkpoint/store/port/checkpoint-store.js";
import { RUNTIME_ERROR_CODES } from "../../runtime/run/error/runtime-error.js";
import {
  assertOriginalCopy,
  checkpointFor,
  expectStoreError,
  firstMessageContent,
  suspendedCheckpoint,
  withMessage,
  type ContractCase,
  type ContractContext,
} from "./contract-support.js";

export function checkpointLifecycleCases(): readonly ContractCase[] {
  return [
    {
      name: "delete tombstone/active claim is busy",
      run: async ({ freshStore, signal }: ContractContext): Promise<void> => {
        const store = await freshStore();
        const created = await store.save(
          {
            checkpoint: suspendedCheckpoint("delete-claim", "", "call-delete"),
            expectedRevision: 0n,
            fencingToken: 0n,
          },
          signal,
        );
        const claimed = await store.consumeInterrupt(
          {
            threadId: "delete-claim",
            userId: "",
            interruptId: "call-delete",
            requestId: "delete-owner",
            response: "yes",
            expectedRevision: created.revision,
            fencingToken: 0n,
          },
          signal,
        );
        await expectStoreError(
          store.delete(
            {
              threadId: "delete-claim",
              userId: "",
              expectedRevision: claimed.record.revision,
              fencingToken: 0n,
            },
            signal,
          ),
          RUNTIME_ERROR_CODES.THREAD_BUSY,
        );
      },
    },
    {
      name: "delete tombstone/prevents ABA and supports CAS rebuild",
      run: async ({ freshStore, signal }: ContractContext): Promise<void> => {
        const store = await freshStore();
        const checkpoint = checkpointFor("deleted", "owner", "before delete");
        const created = await store.save(
          { checkpoint, expectedRevision: 0n, fencingToken: 0n },
          signal,
        );
        await expectStoreError(
          store.delete(
            {
              threadId: "deleted",
              userId: "owner",
              expectedRevision: 0n,
              fencingToken: 0n,
            },
            signal,
          ),
          RUNTIME_ERROR_CODES.REVISION_CONFLICT,
        );
        const deletedRevision = await store.delete(
          {
            threadId: "deleted",
            userId: "owner",
            expectedRevision: created.revision,
            fencingToken: 0n,
          },
          signal,
        );
        assert.equal(deletedRevision, created.revision + 1n);
        const tombstone = await expectStoreError(
          store.load(
            { threadId: "deleted", userId: "owner", fencingToken: 0n },
            signal,
          ),
          RUNTIME_ERROR_CODES.CHECKPOINT_NOT_FOUND,
        );
        assert.equal(tombstone.record?.revision, deletedRevision);
        assert.equal(tombstone.record?.checkpoint.threadId, "deleted");
        assert.equal(tombstone.record?.checkpoint.userId, "owner");
        const repeated = await expectStoreError(
          store.delete(
            {
              threadId: "deleted",
              userId: "owner",
              expectedRevision: deletedRevision,
              fencingToken: 0n,
            },
            signal,
          ),
          RUNTIME_ERROR_CODES.CHECKPOINT_NOT_FOUND,
        );
        assert.equal(repeated.record?.revision, deletedRevision);
        await expectStoreError(
          store.save(
            {
              checkpoint: withMessage(checkpoint, "unsafe ABA"),
              expectedRevision: created.revision,
              fencingToken: 0n,
            },
            signal,
          ),
          RUNTIME_ERROR_CODES.REVISION_CONFLICT,
        );
        const rebuilt = await store.save(
          {
            checkpoint: withMessage(checkpoint, "safe rebuild"),
            expectedRevision: deletedRevision,
            fencingToken: 0n,
          },
          signal,
        );
        assert.equal(rebuilt.revision, deletedRevision + 1n);
        const loaded = await store.load(
          { threadId: "deleted", userId: "owner", fencingToken: 0n },
          signal,
        );
        assert.equal(loaded.revision, rebuilt.revision);
        assert.equal(firstMessageContent(loaded), "safe rebuild");
      },
    },
    {
      name: "delete tombstone/clears resume receipts before rebuild",
      run: async ({ freshStore, signal }: ContractContext): Promise<void> => {
        const store = await freshStore();
        const created = await store.save(
          {
            checkpoint: suspendedCheckpoint(
              "receipt-delete",
              "owner",
              "call-reused",
            ),
            expectedRevision: 0n,
            fencingToken: 0n,
          },
          signal,
        );
        const request: ConsumeInterruptRequest = {
          threadId: "receipt-delete",
          userId: "owner",
          interruptId: "call-reused",
          requestId: "request-reused",
          response: "yes",
          expectedRevision: created.revision,
          fencingToken: 0n,
        };
        const claimed = await store.consumeInterrupt(request, signal);
        const finalCheckpoint = cloneCheckpoint(claimed.record.checkpoint);
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
        const deletedRevision = await store.delete(
          {
            threadId: request.threadId,
            userId: request.userId,
            expectedRevision: completed.revision,
            fencingToken: 0n,
          },
          signal,
        );
        const rebuilt = await store.save(
          {
            checkpoint: suspendedCheckpoint(
              request.threadId,
              request.userId,
              request.interruptId,
            ),
            expectedRevision: deletedRevision,
            fencingToken: 0n,
          },
          signal,
        );
        const reused = await store.consumeInterrupt(
          { ...request, expectedRevision: rebuilt.revision },
          signal,
        );
        assert.equal(reused.disposition, CONSUME_DISPOSITIONS.CLAIMED);
        assert.equal(reused.record.revision, rebuilt.revision + 1n);
      },
    },
    {
      name: "records are deep copied",
      run: async ({ freshStore, signal }: ContractContext): Promise<void> => {
        const store = await freshStore();
        const sourceFunction = {
          name: "ask",
          arguments: '{"value":"original"}',
        };
        const sourceMeta: Record<string, string> = { state: "original" };
        const sourceArguments: Record<string, string> = {
          argument: "original",
        };
        const sourcePayload: Record<string, string> = { payload: "original" };
        const checkpoint: Checkpoint = {
          ...suspendedCheckpoint("copies", "", "call-copy"),
          messages: [
            {
              role: "assistant",
              content: "original",
              toolCalls: [
                {
                  id: "call-copy",
                  type: "function",
                  function: sourceFunction,
                },
              ],
            },
          ],
          contentRefs: [{ kind: "object", key: "key", meta: sourceMeta }],
          interrupt: {
            toolCallId: "call-copy",
            toolName: "ask",
            arguments: sourceArguments,
            payload: sourcePayload,
          },
        };
        const created = await store.save(
          { checkpoint, expectedRevision: 0n, fencingToken: 0n },
          signal,
        );
        checkpoint.messages[0] = {
          role: "assistant",
          content: "mutated input",
        };
        sourceFunction.name = "mutated input";
        sourceMeta["state"] = "mutated input";
        sourceArguments["argument"] = "mutated input";
        sourcePayload["payload"] = "mutated input";
        created.checkpoint.messages[0] = {
          role: "assistant",
          content: "mutated result",
        };
        created.checkpoint.contentRefs[0] = {
          kind: "object",
          key: "key",
          meta: { state: "mutated result" },
        };
        created.checkpoint.interrupt = {
          toolCallId: "call-copy",
          toolName: "mutated result",
          arguments: {},
          payload: {},
        };

        const loaded = await store.load(
          { threadId: "copies", userId: "", fencingToken: 0n },
          signal,
        );
        assertOriginalCopy(loaded);
        loaded.checkpoint.messages[0] = {
          role: "assistant",
          content: "mutated load",
        };
        loaded.checkpoint.contentRefs[0] = {
          kind: "object",
          key: "key",
          meta: { state: "mutated load" },
        };
        loaded.checkpoint.interrupt = {
          toolCallId: "call-copy",
          toolName: "mutated load",
          arguments: {},
          payload: {},
        };
        const reloaded = await store.load(
          { threadId: "copies", userId: "", fencingToken: 0n },
          signal,
        );
        assertOriginalCopy(reloaded);

        const request: ConsumeInterruptRequest = {
          threadId: "copies",
          userId: "",
          interruptId: "call-copy",
          requestId: "copy-request",
          response: "original response",
          expectedRevision: reloaded.revision,
          fencingToken: 0n,
        };
        const claimed = await store.consumeInterrupt(request, signal);
        if (claimed.record.checkpoint.resumeClaim) {
          claimed.record.checkpoint.resumeClaim.response =
            "mutated claim result";
        }
        claimed.record.checkpoint.contentRefs[0] = {
          kind: "object",
          key: "key",
          meta: { state: "mutated claim result" },
        };
        const inProgress = await store.consumeInterrupt(request, signal);
        assert.equal(
          inProgress.record.checkpoint.resumeClaim?.response,
          "original response",
        );
        assert.equal(
          inProgress.record.checkpoint.contentRefs[0]?.meta?.["state"],
          "original",
        );
        const completedCheckpoint = withMessage(
          inProgress.record.checkpoint,
          "completed original",
        );
        completedCheckpoint.resumeClaim = undefined;
        completedCheckpoint.lastResumeInterrupt = "call-copy";
        completedCheckpoint.status = CHECKPOINT_STATUSES.COMPLETED;
        const completed = await store.save(
          {
            checkpoint: completedCheckpoint,
            expectedRevision: inProgress.record.revision,
            fencingToken: 0n,
            claimRequestId: "copy-request",
          },
          signal,
        );
        completed.checkpoint.messages[0] = {
          role: "assistant",
          content: "mutated completion",
        };
        completed.checkpoint.contentRefs[0] = {
          kind: "object",
          key: "key",
          meta: { state: "mutated completion" },
        };
        const replayed = await store.consumeInterrupt(request, signal);
        assert.equal(replayed.disposition, CONSUME_DISPOSITIONS.REPLAYED);
        assert.equal(
          firstMessageContent(replayed.record),
          "completed original",
        );
        assert.equal(
          replayed.record.checkpoint.contentRefs[0]?.meta?.["state"],
          "original",
        );
      },
    },
  ];
}
