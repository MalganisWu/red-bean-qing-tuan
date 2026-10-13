import type { Interrupt } from "../../../protocol/interrupt.js";
import type { RuntimeContext } from "../../context/runtime-context.js";

/**
 * 允许宿主把挂起的 Runtime 调用投影为自己的表现层模型。
 * SDK 没有默认实现；高层通过 AgentRuntimeOptions 注入，低层通过 ReactAgentExecutionOptions 注入。
 */
export interface InterruptAssembler {
  /**
   * 把挂起的中断投影成宿主自己的表现层模型。
   *
   * 由 SDK 在运行进入挂起态时调用；实现抛错会被视为执行失败而非致命错误，
   * 上层据此把停止原因归为 LLM 错误。因此实现应当只做表现层投影，不要在这里发起不可回滚的副作用。
   *
   * @param context - 本次运行上下文；宿主可读取其中的元数据与身份信息来构造展示模型。
   * @param interrupt - SDK 组装好的中断描述，含待确认的工具调用与其参数。
   */
  assemble(context: RuntimeContext, interrupt: Interrupt): Promise<void>;
}
