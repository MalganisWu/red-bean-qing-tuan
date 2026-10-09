import type { RuntimeContext } from "../../context/runtime-context.js";

/** Pipeline 中可独立执行的节点；SDK 默认 Agent 实现为 AgentNode，由宿主加入 PipelineBuilder。 */
export interface RuntimeNode {
  readonly name: string;
  execute(context: RuntimeContext, signal: AbortSignal): Promise<void>;
}
