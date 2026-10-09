import type { RuntimeContext } from "../../context/runtime-context.js";
import type { RuntimeNode } from "../port/runtime-node.js";
import {
  ReactAgentExecution,
  type ReactAgentExecutionOptions,
} from "../../execution/service/react-agent-execution.js";

/** AgentNode 透传给统一 Agent 执行组件的构造配置。 */
export type AgentNodeOptions = ReactAgentExecutionOptions;

/**
 * 将统一的 Agent 执行组件暴露为 Pipeline Node。
 * 高层 AgentRuntime 与低层 Pipeline 因而不会各自维护一套 ReAct 包装逻辑。
 */
export class AgentNode implements RuntimeNode {
  public readonly name = "AgentNode";
  readonly #execution: ReactAgentExecution;

  public constructor(options: AgentNodeOptions) {
    this.#execution = new ReactAgentExecution(options);
  }

  public async execute(
    context: RuntimeContext,
    signal: AbortSignal,
  ): Promise<void> {
    await this.#execution.execute(context, signal);
  }
}
