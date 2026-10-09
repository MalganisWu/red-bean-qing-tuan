import type { ContentRef } from "../../../protocol/content-reference.js";
import type { Interrupt } from "../../../protocol/interrupt.js";
import type { RawMessage } from "../../../protocol/message.js";

/** Runtime checkpoint 的稳定终态与挂起态。 */
export type CheckpointStatus =
  "completed" | "suspended" | "exhausted" | "cancelled" | "failed";

/** 已领取的恢复请求；由 CheckpointStore 保证认领和提交的原子语义。 */
export interface ResumeClaim {
  interruptId: string;
  requestId: string;
  response: string;
  claimedAt: number;
}

/** Runtime 可持久化状态，不包含产品 Session 或展示模型。 */
export interface Checkpoint {
  version: number;
  threadId: string;
  userId: string;
  status: CheckpointStatus;
  messages: RawMessage[];
  contentRefs: ContentRef[];
  interrupt?: Interrupt | undefined;
  resumeClaim?: ResumeClaim | undefined;
  lastResumeInterrupt: string;
  tokensUsed: number;
  finishReason: string;
}
