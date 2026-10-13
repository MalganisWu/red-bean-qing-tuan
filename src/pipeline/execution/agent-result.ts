/** `RuntimeContext.metadata` 中存放 `AgentResult` 的键；Pipeline 外的调用方按它读执行结论。 */
export const AGENT_RESULT_METADATA_KEY = "agent_result";
/** `RuntimeContext.metadata` 中存放本次运行 token 用量的键。 */
export const TOKENS_USED_METADATA_KEY = "tokens_used";

/**
 * Agent 执行停止原因的稳定取值。
 * 与 `AgentResult.success` 配合使用：`success: false` 说明没跑完，`reason` 说明卡在哪一步。
 * `AWAITING_USER` 是唯一「没跑完但也不是失败」的取值——它在等用户对中断作出回应。
 */
export const AGENT_RESULT_REASONS = Object.freeze({
  COMPLETED: "completed",
  CANCELLED: "cancelled",
  MAX_ITERATIONS: "max_iterations",
  LLM_ERROR: "llm_error",
  HOOK_FATAL: "hook_fatal",
  AWAITING_USER: "awaiting_user",
} as const);

/** Agent 执行停止的稳定原因。 */
export type AgentResultReason =
  (typeof AGENT_RESULT_REASONS)[keyof typeof AGENT_RESULT_REASONS];

/** Pipeline Agent 节点写入 RuntimeContext 的最小执行结果。 */
export interface AgentResult {
  /** 本次运行是否正常跑完；false 说明中途停住，具体停在哪一步看 reason。 */
  readonly success: boolean;
  /** 停止原因；`awaiting_user` 是唯一「没跑完但也不是失败」的取值。 */
  readonly reason: AgentResultReason;
}
