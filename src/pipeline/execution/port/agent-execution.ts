import type { RuntimeContext } from "../../context/runtime-context.js";
import type { ReactResult } from "../../react-loop/react-loop.js";

/**
 * 连接高层 Runtime 与 ReAct 主循环的执行能力。
 * 默认实现为 ReactAgentExecution；高层由 runtime-composition.ts 组装，低层由 AgentNode 显式构造。
 */
export interface AgentExecution {
  execute(context: RuntimeContext, signal: AbortSignal): Promise<ReactResult>;
}
