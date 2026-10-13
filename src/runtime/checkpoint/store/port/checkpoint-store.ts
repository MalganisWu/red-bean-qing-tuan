import type { Checkpoint } from "../../model/checkpoint.js";

/**
 * `consumeInterrupt` 的三种结果，用来区分「这次真的推进了状态」与「这个 requestId 来过了」。
 *
 * - `CLAIMED`：本次调用完成了认领，调用方应当继续执行工具并写出终态。
 * - `IN_PROGRESS`：同一 requestId 的上一次认领尚未落终态，重放方应等待而非另起一次执行。
 * - `REPLAYED`：终态已存在，直接采用返回的记录，不再调用模型或工具。
 *
 * 三种结果都携带记录，调用方无需为了拿到状态再查一次。
 */
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
  /** Checkpoint 领域状态本体；与 revision 一并读出，构成一次不可分割的读取结果。 */
  checkpoint: Checkpoint;
  /** 单调递增的写版本；所有写入都必须以它为 CAS 期望值，不能只依赖 checkpoint 内容比较。 */
  revision: bigint;
}

/** 按宿主所有权和 fencing token 读取 Checkpoint 的请求。 */
export interface LoadCheckpointRequest {
  /** 目标会话标识；不存在、已删除或越权时，实现须按所有权隐藏返回 CHECKPOINT_NOT_FOUND。 */
  readonly threadId: string;
  /** 所有权标识；空串表示调用方不声明身份，此时不做归属校验（见 CheckpointStore 注释）。 */
  readonly userId: string;
  /** 宿主 lease 系统发放的 fencing token；`0n` 表示该 thread 未启用 fencing。 */
  readonly fencingToken: bigint;
}

/** 以 expectedRevision 执行 CAS 保存的请求；冲突必须显式失败。 */
export interface SaveCheckpointRequest {
  /** 待写入的完整 Checkpoint；实现应深拷贝后再落盘，写入后调用方副本不受影响。 */
  readonly checkpoint: Checkpoint;
  /** CAS 期望值。与 Store 当前 revision 不等时必须失败，不得「尽力而为」地覆盖。 */
  readonly expectedRevision: bigint;
  /** 宿主 lease 系统发放的 fencing token；`0n` 表示该 thread 未启用 fencing，只接受非递减的值。 */
  readonly fencingToken: bigint;
  /**
   * 仅用于 resume 的终态写入：认领时传入的 requestId。
   * 普通 run 必须省略它；省略/不匹配都表示「试图越过认领直接写」，Store 应拒绝。
   */
  readonly claimRequestId?: string | undefined;
}

/** 原子消费中断响应并推进 Checkpoint 的请求。 */
export interface ConsumeInterruptRequest {
  /** 目标会话标识；不存在、已删除或越权时按所有权隐藏处理。 */
  readonly threadId: string;
  /** 所有权标识；空串表示调用方不声明身份，此时跳过归属校验。 */
  readonly userId: string;
  /** 被响应的中断对应的工具调用 ID；必须与当前挂起点一致。 */
  readonly interruptId: string;
  /** 幂等键。同一 requestId 的重放必须返回首次结果，不得重复执行。 */
  readonly requestId: string;
  /** 宿主对中断的应答载荷，原样保存以备重放。 */
  readonly response: string;
  /** CAS 期望的 revision；与当前值不等即抛 REVISION_CONFLICT，阻止基于陈旧视图的认领。 */
  readonly expectedRevision: bigint;
  /** 宿主 lease 系统发放的 fencing token；`0n` 表示该 thread 未启用 fencing。 */
  readonly fencingToken: bigint;
}

/** 中断消费后的最新记录及其认领处置结果。 */
export interface ConsumeInterruptResult {
  /** 认领或重放后的最新记录；重放时即为首次认领留下的结果。 */
  readonly record: CheckpointRecord;
  /** 本次调用的处置：首次认领、并发进行中还是幂等重放，调用方据此决定是否继续执行。 */
  readonly disposition: ConsumeInterruptDisposition;
}

/** 受所有权、revision 与 fencing 共同保护的删除请求。 */
export interface DeleteCheckpointRequest {
  /** 目标会话标识；不存在、已删除或越权时按所有权隐藏处理。 */
  readonly threadId: string;
  /** 所有权标识；空串表示调用方不声明身份，此时跳过归属校验。 */
  readonly userId: string;
  /** CAS 期望的 revision；不等即失败，避免删掉别人刚写入的状态。 */
  readonly expectedRevision: bigint;
  /** 宿主 lease 系统发放的 fencing token；`0n` 表示该 thread 未启用 fencing。 */
  readonly fencingToken: bigint;
}

/**
 * 宿主实现的 Checkpoint 持久化 Port。
 * 实现必须保持 CAS、fencing、恢复认领和所有权隐藏语义。
 * SDK 的 MemoryCheckpointStore 仅用于单进程参考与契约测试；生产实现由宿主构造并通过 AgentRuntimeOptions 注入。
 *
 * 逐条展开这四条语义，因为它们是实现能不能用的判据，而不是风格建议：
 *
 * - **CAS**：`save`/`consumeInterrupt`/`delete` 都以 `expectedRevision` 为条件，不符即抛
 *   `REVISION_CONFLICT`。revision 每次成功写入递增，且**删除也递增**——它写的是墓碑，不是移除。
 * - **fencing**：`fencingToken` 是宿主 lease 系统发放的高水位。Store 只接受非递减的 token 并
 *   拒绝已过期的持有者。**`0n` 的语义是「未启用 fencing」**，因此一个已经被非零 token 写过的
 *   thread 不能退回 `0n`。注意 fencing 只保护 checkpoint 提交，
 *   工具副作用是否 exactly-once、lease 超时如何接管，都是宿主的责任。
 * - **恢复认领**：一次 resume 分两次写入——`consumeInterrupt` 认领，随后带 `claimRequestId` 的
 *   `save` 落终态。认领之后，普通 run 不得覆盖结果。
 * - **所有权隐藏**：`userId` 不匹配时返回 `CHECKPOINT_NOT_FOUND`，而不是任何形式的越权错误，
 *   否则调用方可以靠错误码探测他人 thread 是否存在。
 *
 * 方法之间没有隐含调用顺序，但实现必须让每个方法单独调用时也满足上述语义：
 * Runtime 会在任意时刻取消（`AbortSignal` 已触发时必须不产生任何副作用）。
 */
export interface CheckpointStore {
  /**
   * 读取当前记录。thread 不存在、尚未落盘或被删除时抛 `CHECKPOINT_NOT_FOUND`，
   * 错误中携带当前记录，调用方据此获得 revision。
   *
   * @param request - 读取输入；userId 决定所有权校验，非零 fencingToken 会先推进高水位
   * @param signal - 调用方取消信号；已触发时实现不得产生任何副作用
   * @returns 记录的深拷贝副本；不存在、已删除或越权时以 CHECKPOINT_NOT_FOUND 拒绝
   */
  load(
    request: LoadCheckpointRequest,
    signal: AbortSignal,
  ): Promise<CheckpointRecord>;
  /**
   * CAS 保存并返回新记录（revision + 1）。
   * resume 的两次写入共用本方法，靠 `claimRequestId` 区分：认领后的终态写入必须回填它。
   *
   * @param request - 保存输入；claimRequestId 仅在 resume 终态写入时回填，普通 run 必须省略
   * @param signal - 调用方取消信号；已触发时实现不得产生任何副作用
   * @returns 落盘后的新记录，revision 已递增
   */
  save(
    request: SaveCheckpointRequest,
    signal: AbortSignal,
  ): Promise<CheckpointRecord>;
  /**
   * 原子地消费中断响应：清空 `interrupt`、写入 `resumeClaim`、推进 revision，并登记幂等回执。
   * 同一 `requestId` 的重放必须返回首次结果而不是重新认领。
   *
   * @param request - 认领输入；requestId 是幂等键，expectedRevision 参与 CAS
   * @param signal - 调用方取消信号；已触发时实现不得产生任何副作用
   * @returns 最新记录与本次处置（首次认领、进行中或幂等重放）
   */
  consumeInterrupt(
    request: ConsumeInterruptRequest,
    signal: AbortSignal,
  ): Promise<ConsumeInterruptResult>;
  /**
   * 删除 checkpoint 内容并返回新 revision。
   * 实现必须保留 fencing 高水位与 revision，使其成为墓碑而非真正的移除。
   *
   * @param request - 删除输入；expectedRevision 参与 CAS，userId 参与所有权校验
   * @param signal - 调用方取消信号；已触发时实现不得产生任何副作用
   * @returns 墓碑记录递增后的 revision；fencing 高水位不得因此回落
   */
  delete(
    request: DeleteCheckpointRequest,
    signal: AbortSignal,
  ): Promise<bigint>;
}
