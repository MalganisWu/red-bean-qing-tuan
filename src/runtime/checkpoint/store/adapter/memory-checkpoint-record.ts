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

/**
 * 创建带 identity 的空记录；revision/fence 会在墓碑生命周期中继续保留。
 * @param threadId - 记录所属的 thread；同一 thread 的记录会复用同一条墓碑并保留其高水位。
 * @param userId - 记录声明的所有者；空串表示无主，之后任意身份的写入都可认领它。
 * @returns `present` 为 false 的未落盘记录，fencingToken 与 revision 均从 0 起。
 */
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
 * @param threadId - 新 Checkpoint 归属的 thread 标识。
 * @param userId - 新 Checkpoint 的所有者；空串表示未声明身份。
 * @returns 状态为 COMPLETED、消息与内容引用均为空的 Checkpoint，内容由调用方后续填充。
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
 * @param checkpoint - 待判定的 Checkpoint；只读取其 userId，不修改内容。
 * @param userId - 请求方声明的身份；空串表示未声明，一律放行。
 * @returns 判定通过返回 true；两侧都声明了身份且不相等时返回 false，调用方须据此按越权处理。
 */
export function checkpointOwnedBy(
  checkpoint: Checkpoint,
  userId: string,
): boolean {
  return (
    userId === "" || checkpoint.userId === "" || checkpoint.userId === userId
  );
}

/**
 * fencing 高水位只能前进；已经 fenced 的 thread 不允许退回 token 0。
 * @param record - 就地推进的内存记录；调用方须保证无论本次是否抛错，推进结果都会写回 Map，失败也要消耗水位。
 * @param token - 本次调用携带的 fencing token；0 仅在从未推进过时放行，小于当前高水位一律 STALE_FENCE，大于则抬高水位。
 */
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

/**
 * 溢出即当作 CAS 失败上报：继续回绕会让「新 revision」与历史值重合，破坏 CAS 的判别力。
 * @param revision - 当前已落盘的 revision，须是上一次成功写入经本函数产出的值，不能来自调用方自算。
 * @returns 下一个 revision；到达 uint64 上限时抛 REVISION_CONFLICT 而不回绕。
 */
export function incrementRevision(revision: bigint): bigint {
  if (revision === MAX_UINT64)
    throw new CheckpointStoreError(RUNTIME_ERROR_CODES.REVISION_CONFLICT);
  return revision + 1n;
}
