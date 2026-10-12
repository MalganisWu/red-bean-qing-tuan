import type { ContentRef } from "../../../protocol/content-reference.js";
import type { Interrupt } from "../../../protocol/interrupt.js";
import type { RawMessage } from "../../../protocol/message.js";

/** Runtime checkpoint 的稳定终态与挂起态。 */
export type CheckpointStatus =
  "completed" | "suspended" | "exhausted" | "cancelled" | "failed";

/**
 * 已领取的恢复请求；由 CheckpointStore 保证认领和提交的原子语义。
 *
 * 它同时承担两个职责：**互斥标记**（存在即表示有人正在处理这个 thread）和
 * **幂等凭据**（`requestId` 是后续写终态时必须自证的身份）。
 * `response` 原样保存，供重放时逐字节比对——同一个 requestId 不能承载两次不同的回答。
 */
export interface ResumeClaim {
  interruptId: string;
  requestId: string;
  response: string;
  claimedAt: number;
}

/**
 * Runtime 可持久化状态，不包含产品 Session 或展示模型。
 *
 * 字段分四类，各自的生命周期不同：
 * - **身份**：`threadId` / `userId`。`userId` 为空串表示无主，见 `checkpointOwnedBy`。
 * - **内容**：`messages` / `contentRefs` / `tokensUsed` / `finishReason`。
 *   `contentRefs` 是工具寄存的大块内容的引用，随上下文一起被恢复。
 * - **状态机**：`status` / `interrupt` / `resumeClaim`。三者互斥地表达「现在处于哪一步」——
 *   挂起时有 `interrupt`，认领后 `interrupt` 被清空而 `resumeClaim` 出现。
 * - **历史痕迹**：`lastResumeInterrupt`。它记的是**最近一次已消费**的中断 ID，
 *   而不是当前挂起点；判断「这个中断是不是已经处理过」靠它。
 *
 * `revision` 不在其中：它属于记录层（`CheckpointRecord`），与内容生命周期分开演进。
 * `version` 则是结构代次，用于将来兼容旧格式。
 */
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
