import type { Checkpoint } from "../../checkpoint/model/checkpoint.js";
import type { RawMessage } from "../../../protocol/message.js";

/**
 * 启动一次 Agent 运行的中性输入 DTO；宿主 HTTP 字段不得泄漏到此处。
 *
 * 三组字段各自的约束（由 runtime-request-validator 强制）：
 * - `input` 与 `messages` **互斥**：前者是「这一轮用户说了什么」的简写（会被包成一条 user 消息），
 *   后者是完整消息数组。两者至少有其一。
 * - `state`、`history` 只在**无 Store 模式**下可用；配了 `checkpointStore` 时传入会直接失败，
 *   因为那会让状态出现两个事实来源。配了 Store 后 `threadId` 必填。
 * - `expectedRevision`、`fencingToken` 是 **Store 专属**字段，无 Store 时传非零值会被拒绝，
 *   而不是被静默忽略——静默忽略会让人误以为拿到了 CAS/fencing 保护。
 */
export interface AgentRequest {
  readonly threadId?: string | undefined;
  readonly userId?: string | undefined;
  readonly requestId?: string | undefined;
  readonly traceId?: string | undefined;
  readonly input?: string | undefined;
  readonly messages?: readonly RawMessage[] | undefined;
  readonly history?: readonly RawMessage[] | undefined;
  /** 由宿主持久化并在新一轮运行时交回的 Runtime 状态。 */
  readonly state?: Checkpoint | undefined;
  readonly expectedRevision?: bigint | undefined;
  readonly fencingToken?: bigint | undefined;
}

/**
 * 恢复一次已中断运行的输入 DTO。
 *
 * `interruptId` 与 `response` 必填：前者指定在回答哪个中断，后者是回答内容
 * （**空字符串是合法回答**，例如「什么都不填就确认」）。
 * `threadId` 可以从 `state` 补，但两处都给了就必须一致。
 * Store 模式下 `requestId` 也必填——它是这条路径唯一的幂等键。
 */
export interface ResumeRequest {
  readonly threadId?: string | undefined;
  readonly interruptId: string;
  readonly response: string;
  readonly state?: Checkpoint | undefined;
  readonly userId?: string | undefined;
  readonly requestId?: string | undefined;
  readonly traceId?: string | undefined;
  readonly expectedRevision?: bigint | undefined;
  readonly fencingToken?: bigint | undefined;
}
