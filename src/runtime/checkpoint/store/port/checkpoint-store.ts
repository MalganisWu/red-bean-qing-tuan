import type { Checkpoint } from "../../model/checkpoint.js";

export const CONSUME_DISPOSITIONS = Object.freeze({
  CLAIMED: "claimed",
  IN_PROGRESS: "in_progress",
  REPLAYED: "replayed",
} as const);

/** 恢复认领的原子结果，用于区分首次领取、并发处理中与幂等回放。 */
export type ConsumeInterruptDisposition =
  (typeof CONSUME_DISPOSITIONS)[keyof typeof CONSUME_DISPOSITIONS];

/** Checkpoint 与其 CAS revision 的不可分割读取结果。 */
export interface CheckpointRecord {
  checkpoint: Checkpoint;
  revision: bigint;
}

/** 按宿主所有权和 fencing token 读取 Checkpoint 的请求。 */
export interface LoadCheckpointRequest {
  readonly threadId: string;
  readonly userId: string;
  readonly fencingToken: bigint;
}

/** 以 expectedRevision 执行 CAS 保存的请求；冲突必须显式失败。 */
export interface SaveCheckpointRequest {
  readonly checkpoint: Checkpoint;
  readonly expectedRevision: bigint;
  readonly fencingToken: bigint;
  readonly claimRequestId?: string | undefined;
}

/** 原子消费中断响应并推进 Checkpoint 的请求。 */
export interface ConsumeInterruptRequest {
  readonly threadId: string;
  readonly userId: string;
  readonly interruptId: string;
  readonly requestId: string;
  readonly response: string;
  readonly expectedRevision: bigint;
  readonly fencingToken: bigint;
}

/** 中断消费后的最新记录及其认领处置结果。 */
export interface ConsumeInterruptResult {
  readonly record: CheckpointRecord;
  readonly disposition: ConsumeInterruptDisposition;
}

/** 受所有权、revision 与 fencing 共同保护的删除请求。 */
export interface DeleteCheckpointRequest {
  readonly threadId: string;
  readonly userId: string;
  readonly expectedRevision: bigint;
  readonly fencingToken: bigint;
}

/**
 * 宿主实现的 Checkpoint 持久化 Port。
 * 实现必须保持 CAS、fencing、恢复认领和所有权隐藏语义。
 * SDK 的 MemoryCheckpointStore 仅用于单进程参考与契约测试；生产实现由宿主构造并通过 AgentRuntimeOptions 注入。
 */
export interface CheckpointStore {
  load(
    request: LoadCheckpointRequest,
    signal: AbortSignal,
  ): Promise<CheckpointRecord>;
  save(
    request: SaveCheckpointRequest,
    signal: AbortSignal,
  ): Promise<CheckpointRecord>;
  consumeInterrupt(
    request: ConsumeInterruptRequest,
    signal: AbortSignal,
  ): Promise<ConsumeInterruptResult>;
  delete(
    request: DeleteCheckpointRequest,
    signal: AbortSignal,
  ): Promise<bigint>;
}
