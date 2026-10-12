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
  status: CheckpointStatus;
  output: string;
  messages: RawMessage[];
  interrupt?: Checkpoint["interrupt"];
  tokensUsed: number;
  finishReason: string;
  checkpoint: Checkpoint;
  revision: bigint;
}
