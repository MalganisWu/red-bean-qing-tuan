export const AGENT_RESULT_METADATA_KEY = "agent_result";
export const TOKENS_USED_METADATA_KEY = "tokens_used";

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
  readonly success: boolean;
  readonly reason: AgentResultReason;
}
