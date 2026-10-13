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
  /** 运行所属线程；配了 checkpointStore 时必填。 */
  readonly threadId?: string | undefined;
  /** 所有权标识；省略或空串表示不声明身份，此时不做归属校验。 */
  readonly userId?: string | undefined;
  /** 调用方声明的请求标识，用于日志与事件关联；省略时由 Runtime 生成。 */
  readonly requestId?: string | undefined;
  /** 追踪标识，用于把本次运行与宿主的分布式追踪串联。 */
  readonly traceId?: string | undefined;
  /** 本轮用户输入的简写，会被包成一条 user 消息；与 messages 互斥，两者至少有其一。 */
  readonly input?: string | undefined;
  /** 完整消息数组；与 input 互斥。 */
  readonly messages?: readonly RawMessage[] | undefined;
  /** 历史消息；仅在无 Store 模式下可用，配 Store 时传入会失败。 */
  readonly history?: readonly RawMessage[] | undefined;
  /** 由宿主持久化并在新一轮运行时交回的 Runtime 状态。 */
  readonly state?: Checkpoint | undefined;
  /** Store 专属的 CAS 期望 revision；无 Store 模式传非零值会被拒绝，而不是被静默忽略。 */
  readonly expectedRevision?: bigint | undefined;
  /** Store 专属的 fencing token；无 Store 模式传非零值会被拒绝。 */
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
  /** 恢复目标线程；可从 state 补，两处都给时必须一致。 */
  readonly threadId?: string | undefined;
  /** 要回答的中断标识；必填，指定这次恢复对应的是哪一次挂起。 */
  readonly interruptId: string;
  /** 对中断的回答内容；空字符串是合法回答（例如「什么都不填就确认」）。 */
  readonly response: string;
  /** 宿主交回的中断时 Checkpoint；无 Store 模式下用它恢复上下文。 */
  readonly state?: Checkpoint | undefined;
  /** 所有权标识；省略或空串表示不声明身份。 */
  readonly userId?: string | undefined;
  /** Store 模式下的幂等键；该恢复路径必填，用于区分重复请求。 */
  readonly requestId?: string | undefined;
  /** 追踪标识，用于串联本次恢复与宿主的分布式追踪。 */
  readonly traceId?: string | undefined;
  /** Store 专属的 CAS 期望 revision；无 Store 模式传非零值会被拒绝。 */
  readonly expectedRevision?: bigint | undefined;
  /** Store 专属的 fencing token；无 Store 模式传非零值会被拒绝。 */
  readonly fencingToken?: bigint | undefined;
}
