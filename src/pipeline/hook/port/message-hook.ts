import type { RuntimeContext } from "../../context/runtime-context.js";
import type { RuntimeNode } from "../../node/port/runtime-node.js";
import type { RawMessage } from "../../../protocol/message.js";

/**
 * 消息进入持久上下文前后的扩展边界。SDK 提供 NoopMessageHook；未配置时高层不组装 Hook，
 * 自定义实现通过 AgentRuntimeOptions 或 ReactAgentExecutionOptions 注入。
 */
export interface MessageHook {
  onUserMessage(
    context: RuntimeContext,
    message: RawMessage,
    signal: AbortSignal,
  ): Promise<void>;
  onAssistantMessage(
    context: RuntimeContext,
    message: RawMessage,
    signal: AbortSignal,
  ): Promise<void>;
  onToolMessage(
    context: RuntimeContext,
    message: RawMessage,
    signal: AbortSignal,
  ): Promise<void>;
}

/** Pipeline 生命周期 Hook；SDK 提供 NoopPipelineHook，未配置时 PipelineBuilder 使用空 Hook 列表。 */
export interface PipelineHook {
  beforeNode(
    context: RuntimeContext,
    node: RuntimeNode,
    signal: AbortSignal,
  ): Promise<void>;
  afterNode(
    context: RuntimeContext,
    node: RuntimeNode,
    error: Error | undefined,
    signal: AbortSignal,
  ): Promise<void>;
  onPipelineStart(context: RuntimeContext, signal: AbortSignal): Promise<void>;
  onPipelineEnd(
    context: RuntimeContext,
    error: Error | undefined,
    signal: AbortSignal,
  ): Promise<void>;
}
