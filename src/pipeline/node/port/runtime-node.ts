import type { RuntimeContext } from "../../context/runtime-context.js";

/** Pipeline 中可独立执行的节点；SDK 默认 Agent 实现为 AgentNode，由宿主加入 PipelineBuilder。 */
export interface RuntimeNode {
  /** 节点名，用于 pipeline 的错误信息与诊断输出，应在一个 pipeline 内稳定且可辨识。 */
  readonly name: string;
  /**
   * 在给定上下文上执行本节点的一次工作。
   *
   * 返回即表示成功；失败一律抛出，由 pipeline 决定中断后续节点还是继续清理。
   *
   * @param context - 本次运行上下文；节点可读写其中的 llmContext 与 metadata。
   * @param signal - 运行取消信号；节点应尽早响应中止而不是无视它继续跑。
   */
  execute(context: RuntimeContext, signal: AbortSignal): Promise<void>;
}
