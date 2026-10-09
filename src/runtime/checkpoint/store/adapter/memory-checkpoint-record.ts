import { RUNTIME_ERROR_CODES } from "../../../run/error/runtime-error.js";
import type { Checkpoint } from "../../model/checkpoint.js";
import { CHECKPOINT_STATUSES } from "../../checkpoint-status.js";
import type { CheckpointRecord } from "../port/checkpoint-store.js";
import { CheckpointStoreError } from "../checkpoint-store-error.js";

/** 内存 Adapter 保存的记录、fencing 高水位与墓碑状态。 */
export interface MemoryCheckpointRecord {
  record: CheckpointRecord;
  fencingToken: bigint;
  present: boolean;
  deleted: boolean;
}

const MAX_UINT64 = (1n << 64n) - 1n;

/** 创建带 identity 的空记录；revision/fence 会在墓碑生命周期中继续保留。 */
export function emptyMemoryRecord(
  threadId: string,
  userId: string,
): MemoryCheckpointRecord {
  return {
    record: { checkpoint: emptyCheckpoint(threadId, userId), revision: 0n },
    fencingToken: 0n,
    present: false,
    deleted: false,
  };
}

export function emptyCheckpoint(threadId: string, userId: string): Checkpoint {
  return {
    version: 0,
    threadId,
    userId,
    status: CHECKPOINT_STATUSES.COMPLETED,
    messages: [],
    contentRefs: [],
    lastResumeInterrupt: "",
    tokensUsed: 0,
    finishReason: "",
  };
}

export function checkpointOwnedBy(
  checkpoint: Checkpoint,
  userId: string,
): boolean {
  return (
    userId === "" || checkpoint.userId === "" || checkpoint.userId === userId
  );
}

/** fencing 高水位只能前进；已经 fenced 的 thread 不允许退回 token 0。 */
export function advanceFence(
  record: MemoryCheckpointRecord,
  token: bigint,
): void {
  if (token === 0n) {
    if (record.fencingToken !== 0n)
      throw new CheckpointStoreError(RUNTIME_ERROR_CODES.STALE_FENCE);
    return;
  }
  if (token < record.fencingToken)
    throw new CheckpointStoreError(RUNTIME_ERROR_CODES.STALE_FENCE);
  if (token > record.fencingToken) record.fencingToken = token;
}

export function incrementRevision(revision: bigint): bigint {
  if (revision === MAX_UINT64)
    throw new CheckpointStoreError(RUNTIME_ERROR_CODES.REVISION_CONFLICT);
  return revision + 1n;
}
