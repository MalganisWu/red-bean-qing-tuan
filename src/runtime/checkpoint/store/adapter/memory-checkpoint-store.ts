import { RUNTIME_ERROR_CODES } from "../../../../runtime/run/error/runtime-error.js";
import {
  cloneCheckpoint,
  cloneCheckpointRecord,
} from "../../codec/checkpoint-clone.js";
import { CheckpointStoreError } from "../checkpoint-store-error.js";
import {
  CONSUME_DISPOSITIONS,
  type CheckpointRecord,
  type CheckpointStore,
  type ConsumeInterruptRequest,
  type ConsumeInterruptResult,
  type DeleteCheckpointRequest,
  type LoadCheckpointRequest,
  type SaveCheckpointRequest,
} from "../port/checkpoint-store.js";
import {
  advanceFence,
  checkpointOwnedBy,
  emptyCheckpoint,
  emptyMemoryRecord,
  incrementRevision,
  type MemoryCheckpointRecord,
} from "./memory-checkpoint-record.js";
import { MemoryCheckpointReceiptLedger } from "./memory-checkpoint-receipts.js";

/** 支持 CAS、fencing、回执和墓碑语义的进程内参考 Adapter。 */
export class MemoryCheckpointStore implements CheckpointStore {
  readonly #records = new Map<string, MemoryCheckpointRecord>();
  readonly #receipts = new MemoryCheckpointReceiptLedger();
  readonly #now: () => number;

  public constructor(now: () => number = Date.now) {
    this.#now = now;
  }

  public load(
    request: LoadCheckpointRequest,
    signal: AbortSignal,
  ): Promise<CheckpointRecord> {
    return rejected((): CheckpointRecord => this.#load(request, signal));
  }

  public save(
    request: SaveCheckpointRequest,
    signal: AbortSignal,
  ): Promise<CheckpointRecord> {
    return rejected((): CheckpointRecord => this.#save(request, signal));
  }

  public consumeInterrupt(
    request: ConsumeInterruptRequest,
    signal: AbortSignal,
  ): Promise<ConsumeInterruptResult> {
    return rejected((): ConsumeInterruptResult =>
      this.#consumeInterrupt(request, signal),
    );
  }

  public delete(
    request: DeleteCheckpointRequest,
    signal: AbortSignal,
  ): Promise<bigint> {
    return rejected((): bigint => this.#delete(request, signal));
  }

  #load(request: LoadCheckpointRequest, signal: AbortSignal): CheckpointRecord {
    requireActive(signal);
    requireThreadId(request.threadId);
    const existing = this.#records.get(request.threadId);
    if (
      existing &&
      !checkpointOwnedBy(existing.record.checkpoint, request.userId)
    ) {
      throw new CheckpointStoreError(RUNTIME_ERROR_CODES.CHECKPOINT_NOT_FOUND);
    }
    const record =
      existing ?? emptyMemoryRecord(request.threadId, request.userId);
    advanceFence(record, request.fencingToken);
    if (existing || request.fencingToken !== 0n)
      this.#records.set(request.threadId, record);
    if (!existing || !record.present || record.deleted) {
      throw new CheckpointStoreError(
        RUNTIME_ERROR_CODES.CHECKPOINT_NOT_FOUND,
        record.record,
      );
    }
    return cloneCheckpointRecord(record.record);
  }

  #save(request: SaveCheckpointRequest, signal: AbortSignal): CheckpointRecord {
    requireActive(signal);
    requireThreadId(request.checkpoint.threadId);
    const threadId = request.checkpoint.threadId;
    const existing = this.#records.get(threadId);
    if (
      existing &&
      !checkpointOwnedBy(existing.record.checkpoint, request.checkpoint.userId)
    ) {
      throw new CheckpointStoreError(RUNTIME_ERROR_CODES.CHECKPOINT_NOT_FOUND);
    }
    // 即使记录尚不存在，也先建立带 owner 的墓碑状态，使 fence 高水位不会因失败写入而回退。
    const current =
      existing ?? emptyMemoryRecord(threadId, request.checkpoint.userId);
    advanceFence(current, request.fencingToken);
    if (existing || request.fencingToken !== 0n)
      this.#records.set(threadId, current);
    if (current.record.revision !== request.expectedRevision) {
      throw new CheckpointStoreError(RUNTIME_ERROR_CODES.REVISION_CONFLICT);
    }

    const checkpoint = cloneCheckpoint(request.checkpoint);
    if (checkpoint.userId === "" && existing)
      checkpoint.userId = current.record.checkpoint.userId;
    // 已认领的 resume 只能由同一 requestId 完成；普通 run 不得越过 claim 覆盖结果。
    const claim = current.record.checkpoint.resumeClaim;
    if (claim) {
      if (
        request.claimRequestId === undefined ||
        request.claimRequestId === "" ||
        request.claimRequestId !== claim.requestId ||
        checkpoint.resumeClaim !== undefined ||
        checkpoint.lastResumeInterrupt !== claim.interruptId
      ) {
        throw new CheckpointStoreError(RUNTIME_ERROR_CODES.THREAD_BUSY);
      }
    } else if (
      (request.claimRequestId !== undefined && request.claimRequestId !== "") ||
      checkpoint.resumeClaim !== undefined
    ) {
      throw new CheckpointStoreError(RUNTIME_ERROR_CODES.THREAD_BUSY);
    }

    const saved: CheckpointRecord = {
      checkpoint,
      revision: incrementRevision(current.record.revision),
    };
    current.record = cloneCheckpointRecord(saved);
    current.present = true;
    current.deleted = false;
    this.#records.set(threadId, current);

    if (claim) {
      this.#receipts.saveCompletion(
        threadId,
        claim.requestId,
        claim.interruptId,
        claim.response,
        saved,
      );
    }
    return cloneCheckpointRecord(saved);
  }

  #consumeInterrupt(
    request: ConsumeInterruptRequest,
    signal: AbortSignal,
  ): ConsumeInterruptResult {
    requireActive(signal);
    requireThreadId(request.threadId);
    if (request.requestId === "")
      throw new Error("resume request ID must not be empty");

    const existing = this.#records.get(request.threadId);
    if (
      existing &&
      !checkpointOwnedBy(existing.record.checkpoint, request.userId)
    ) {
      throw new CheckpointStoreError(RUNTIME_ERROR_CODES.CHECKPOINT_NOT_FOUND);
    }
    const current =
      existing ?? emptyMemoryRecord(request.threadId, request.userId);
    advanceFence(current, request.fencingToken);
    if (existing || request.fencingToken !== 0n)
      this.#records.set(request.threadId, current);
    if (!existing || !current.present || current.deleted) {
      throw new CheckpointStoreError(
        RUNTIME_ERROR_CODES.CHECKPOINT_NOT_FOUND,
        current.record,
      );
    }

    const receipt = this.#receipts.find(request.threadId, request.requestId);
    if (receipt) {
      if (
        receipt.interruptId !== request.interruptId ||
        receipt.response !== request.response
      ) {
        throw new CheckpointStoreError(
          RUNTIME_ERROR_CODES.IDEMPOTENCY_CONFLICT,
        );
      }
      return {
        record: cloneCheckpointRecord(receipt.record),
        disposition: receipt.completed
          ? CONSUME_DISPOSITIONS.REPLAYED
          : CONSUME_DISPOSITIONS.IN_PROGRESS,
      };
    }

    const checkpoint = current.record.checkpoint;
    if (checkpoint.lastResumeInterrupt === request.interruptId) {
      throw new CheckpointStoreError(
        RUNTIME_ERROR_CODES.INTERRUPT_ALREADY_CONSUMED,
        current.record,
      );
    }
    if (checkpoint.resumeClaim) {
      throw new CheckpointStoreError(
        RUNTIME_ERROR_CODES.RESUME_IN_PROGRESS,
        current.record,
      );
    }
    if (current.record.revision !== request.expectedRevision) {
      throw new CheckpointStoreError(RUNTIME_ERROR_CODES.REVISION_CONFLICT);
    }
    if (!checkpoint.interrupt) {
      throw new CheckpointStoreError(
        RUNTIME_ERROR_CODES.CHECKPOINT_NOT_SUSPENDED,
        current.record,
      );
    }
    if (checkpoint.interrupt.toolCallId !== request.interruptId) {
      throw new CheckpointStoreError(
        RUNTIME_ERROR_CODES.INTERRUPT_MISMATCH,
        current.record,
      );
    }

    const claimedCheckpoint = cloneCheckpoint(checkpoint);
    claimedCheckpoint.interrupt = undefined;
    claimedCheckpoint.resumeClaim = {
      interruptId: request.interruptId,
      requestId: request.requestId,
      response: request.response,
      claimedAt: this.#now(),
    };
    const claimed: CheckpointRecord = {
      checkpoint: claimedCheckpoint,
      revision: incrementRevision(current.record.revision),
    };
    current.record = cloneCheckpointRecord(claimed);
    this.#records.set(request.threadId, current);
    this.#receipts.saveClaim(
      request.threadId,
      request.requestId,
      request.interruptId,
      request.response,
      claimed,
    );
    return {
      record: cloneCheckpointRecord(claimed),
      disposition: CONSUME_DISPOSITIONS.CLAIMED,
    };
  }

  #delete(request: DeleteCheckpointRequest, signal: AbortSignal): bigint {
    requireActive(signal);
    requireThreadId(request.threadId);
    const existing = this.#records.get(request.threadId);
    if (
      existing &&
      !checkpointOwnedBy(existing.record.checkpoint, request.userId)
    ) {
      throw new CheckpointStoreError(RUNTIME_ERROR_CODES.CHECKPOINT_NOT_FOUND);
    }
    const current =
      existing ?? emptyMemoryRecord(request.threadId, request.userId);
    advanceFence(current, request.fencingToken);
    if (existing || request.fencingToken !== 0n)
      this.#records.set(request.threadId, current);
    if (!existing || !current.present || current.deleted) {
      throw new CheckpointStoreError(
        RUNTIME_ERROR_CODES.CHECKPOINT_NOT_FOUND,
        current.record,
      );
    }
    if (current.record.revision !== request.expectedRevision) {
      throw new CheckpointStoreError(RUNTIME_ERROR_CODES.REVISION_CONFLICT);
    }
    if (current.record.checkpoint.resumeClaim)
      throw new CheckpointStoreError(RUNTIME_ERROR_CODES.THREAD_BUSY);

    const revision = incrementRevision(current.record.revision);
    current.record = {
      checkpoint: {
        ...emptyCheckpoint(request.threadId, current.record.checkpoint.userId),
        version: current.record.checkpoint.version,
      },
      revision,
    };
    current.present = false;
    current.deleted = true;
    this.#records.set(request.threadId, current);
    this.#receipts.deleteThread(request.threadId);
    return revision;
  }
}

function requireActive(signal: AbortSignal): void {
  if (signal.aborted) {
    throw signal.reason instanceof Error
      ? signal.reason
      : new DOMException("operation aborted", "AbortError");
  }
}

function requireThreadId(threadId: string): void {
  if (threadId === "")
    throw new Error("checkpoint thread ID must not be empty");
}

function rejected<TOutput>(operation: () => TOutput): Promise<TOutput> {
  try {
    return Promise.resolve(operation());
  } catch (error: unknown) {
    return Promise.reject(
      error instanceof Error ? error : new Error(String(error)),
    );
  }
}
