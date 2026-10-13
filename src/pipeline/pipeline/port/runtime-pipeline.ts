import type { RuntimeContext } from "../../context/runtime-context.js";

/** 按既定顺序运行节点的 Pipeline 边界；SDK 默认实现为由 PipelineBuilder 构造的 SequentialPipeline。 */
export interface RuntimePipeline {
  /**
   * 按既定顺序跑完整条 pipeline。
   *
   * 返回即表示全部节点与清理段都无错；任一环节失败都以异常上抛，且异常可能聚合了多处失败。
   *
   * @param context - 本次运行上下文；清理段的进度会回写到 pipelineError 等字段。
   * @param signal - 运行取消信号；取消会中断正常段，但不应影响 finally 节点的收尾。
   */
  run(context: RuntimeContext, signal: AbortSignal): Promise<void>;
}
