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

/** revision 是 64 位无符号语义；用 bigint 承载但不允许溢出到 65 位。 */
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

/**
 * 空白 Checkpoint。`version` 从 0 起，表示结构代次而非内容版本；
 * `revision` 不在其中，它属于记录层，与内容生命周期分开演进。
 */
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

/**
 * 任一方的 userId 为空即视为「无主」，判定放行。
 * 这是为了让单进程开发与未启用身份的宿主能直接跑通；一旦两侧都声明了身份，
 * 就必须严格相等。注意放行不等于暴露：调用方拿到的是 NOT_FOUND 而非越权提示。
 */
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

/** 溢出即当作 CAS 失败上报：继续回绕会让「新 revision」与历史值重合，破坏 CAS 的判别力。 */
export function incrementRevision(revision: bigint): bigint {
  if (revision === MAX_UINT64)
    throw new CheckpointStoreError(RUNTIME_ERROR_CODES.REVISION_CONFLICT);
  return revision + 1n;
}
