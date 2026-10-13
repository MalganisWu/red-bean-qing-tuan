import type { RawMessage } from "../../../protocol/message.js";
import type {
  Checkpoint,
  CheckpointStatus,
} from "../../checkpoint/model/checkpoint.js";

/**
 * Runtime 返回给宿主的完整结果 DTO，包含可继续持久化的 checkpoint。
 *
 * 字段间的关系，避免宿主任意组合：
 * - `status` 是权威状态，`checkpoint.status` 与它始终一致（同一份数据的两处投影）。
 * - `interrupt` 只在 `status === "suspended"` 时存在，此时宿主应走 `resume` 继续。
 * - `output` 是**最后一条有正文的 assistant 消息**，不是拼接结果；没有则为空串。
 * - `revision` 是该结果在 Store 中的版本，可直接用作下一次调用的 `expectedRevision`。
 *   **无 Store 模式或保存失败时恒为 `0n`**，表示「未知」而非「第 0 版」。
 */
export interface RuntimeResult {
  /** 权威终态；与 `checkpoint.status` 始终一致，是同一份数据的两处投影。 */
  status: CheckpointStatus;
  /** 最后一条有正文的 assistant 消息，不是拼接结果；没有时为空串。 */
  output: string;
  /** 本次运行的完整消息序列，已深拷贝，与 Runtime 内部状态不共享引用。 */
  messages: RawMessage[];
  /** 挂起时的中断；仅在 `status === "suspended"` 时存在，此时宿主应走 resume 继续。 */
  interrupt?: Checkpoint["interrupt"];
  /** 累计消耗的 token 数；0 表示未统计或未提供。 */
  tokensUsed: number;
  /** 模型结束原因短语；空串表示未提供。 */
  finishReason: string;
  /** 可继续持久化的 Checkpoint 快照；其 status 与 result.status 保持一致。 */
  checkpoint: Checkpoint;
  /** 结果在 Store 中的版本，可直接用作下一次调用的 expectedRevision；无 Store 或保存失败时恒为 0n，表示「未知」而非「第 0 版」。 */
  revision: bigint;
}
