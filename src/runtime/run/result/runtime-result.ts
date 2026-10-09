import type { RawMessage } from "../../../protocol/message.js";
import type {
  Checkpoint,
  CheckpointStatus,
} from "../../checkpoint/model/checkpoint.js";

/** Runtime 返回给宿主的完整结果 DTO，包含可继续持久化的 checkpoint。 */
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
