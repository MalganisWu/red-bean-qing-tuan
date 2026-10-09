import type { Interrupt } from "../../../protocol/interrupt.js";
import type { RuntimeContext } from "../../context/runtime-context.js";

/**
 * 允许宿主把挂起的 Runtime 调用投影为自己的表现层模型。
 * SDK 没有默认实现；高层通过 AgentRuntimeOptions 注入，低层通过 ReactAgentExecutionOptions 注入。
 */
export interface InterruptAssembler {
  assemble(context: RuntimeContext, interrupt: Interrupt): Promise<void>;
}
