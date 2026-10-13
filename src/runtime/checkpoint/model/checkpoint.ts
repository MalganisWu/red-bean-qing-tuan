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
  /** 被认领中断的 ID，标明这次恢复对应的是哪一次挂起。 */
  interruptId: string;
  /** 认领方的幂等凭据；后续写终态时必须原样带回来自证身份。 */
  requestId: string;
  /** 恢复时传入的原始回答，逐字节保存，供重放时比对同一 requestId 是否承载了不同内容。 */
  response: string;
  /** 认领发生的时间戳（epoch 毫秒），供宿主实现接管与超时策略。 */
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
  /** 结构代次，用于将来兼容旧格式；0 只属于尚未落盘的内存记录，不是合法的持久化状态。 */
  version: number;
  /** 所属线程 ID，与 `userId` 一起构成所有权键。 */
  threadId: string;
  /** 所有者 ID；空串表示无主，所有权判定见 `checkpointOwnedBy`。 */
  userId: string;
  /** 状态机当前态：终态或挂起态。 */
  status: CheckpointStatus;
  /** 完整消息历史，随 checkpoint 一起被恢复回上下文。 */
  messages: RawMessage[];
  /** 工具寄存的大块内容引用，与 `messages` 同生命周期一起恢复。 */
  contentRefs: ContentRef[];
  /** 当前挂起的中断；认领后被清空，与 `resumeClaim` 互斥地表达所处阶段。 */
  interrupt?: Interrupt | undefined;
  /** 已领取的恢复请求；存在即表示有人正在处理这个 thread，与 `interrupt` 互斥。 */
  resumeClaim?: ResumeClaim | undefined;
  /** 最近一次已消费的中断 ID，而不是当前挂起点；判断某中断是否已处理过靠它。 */
  lastResumeInterrupt: string;
  /** 本次运行累计消耗的 token 数；0 表示未统计或未提供。 */
  tokensUsed: number;
  /** 模型结束原因短语；空串表示未提供。 */
  finishReason: string;
}
