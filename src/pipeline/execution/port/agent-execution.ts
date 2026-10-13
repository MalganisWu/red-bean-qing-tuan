import type { RuntimeContext } from "../../context/runtime-context.js";
import type { ReactResult } from "../../react-loop/react-loop.js";

/**
 * 连接高层 Runtime 与 ReAct 主循环的执行能力。
 * 默认实现为 ReactAgentExecution；高层由 runtime-composition.ts 组装，低层由 AgentNode 显式构造。
 */
export interface AgentExecution {
  /**
   * 跑一次完整的 Agent 执行，并把结论写回上下文元数据。
   *
   * 失败语义：正常终止返回结果；执行失败或取消一律抛出异常，而不是返回一个 `success: false`
   * 的结果——失败那一刻已产生的 `llmContext` 与 token 用量由抛出物携带，供上层持久化。
   *
   * @param context - 本次运行的共享状态；执行过程中会改写其 llmContext 与 metadata。
   * @param signal - 取消信号；已中止时直接抛取消错误，不再发起模型调用。
   * @returns 本次执行的中性结果；`cancelled` 与 `interrupt` 字段区分取消与等待人工确认。
   */
  execute(context: RuntimeContext, signal: AbortSignal): Promise<ReactResult>;
}
