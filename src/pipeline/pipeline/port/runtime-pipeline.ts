import type { RuntimeContext } from "../../context/runtime-context.js";

/** 按既定顺序运行节点的 Pipeline 边界；SDK 默认实现为由 PipelineBuilder 构造的 SequentialPipeline。 */
export interface RuntimePipeline {
  run(context: RuntimeContext, signal: AbortSignal): Promise<void>;
}
