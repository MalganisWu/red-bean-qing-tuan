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
  /** 节点名，用于 pipeline 错误信息与诊断输出；固定为 "AgentNode"。 */
  public readonly name = "AgentNode";
  readonly #execution: ReactAgentExecution;

  public constructor(options: AgentNodeOptions) {
    this.#execution = new ReactAgentExecution(options);
  }

  /**
   * 委托统一 Agent 执行组件跑一次 ReAct；节点自身不追加任何包装逻辑。
   *
   * @param context - 本次运行上下文，透传给执行组件。
   * @param signal - 运行取消信号，透传给执行组件。
   */
  public async execute(
    context: RuntimeContext,
    signal: AbortSignal,
  ): Promise<void> {
    await this.#execution.execute(context, signal);
  }
}
