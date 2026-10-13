import type { RuntimeContext } from "../../context/runtime-context.js";
import type { RuntimeNode } from "../../node/port/runtime-node.js";
import type { RawMessage } from "../../../protocol/message.js";

/**
 * 消息进入持久上下文前后的扩展边界。SDK 提供 NoopMessageHook；未配置时高层不组装 Hook，
 * 自定义实现通过 AgentRuntimeOptions 或 ReactAgentExecutionOptions 注入。
 */
export interface MessageHook {
  /**
   * 在 user 消息进入持久上下文后回调。
   *
   * 抛普通错误只记录并放行，抛 `HookFatalError` 才中止整条 pipeline；是否致命由 Hook 作者决定。
   *
   * @param context - 本次运行上下文，供 Hook 读取身份与元数据。
   * @param message - 刚提交的 user 消息。
   * @param signal - 运行取消信号，Hook 应据此尽早放弃。
   */
  onUserMessage(
    context: RuntimeContext,
    message: RawMessage,
    signal: AbortSignal,
  ): Promise<void>;
  /**
   * 在 assistant 消息进入持久上下文后回调；失败语义与 user 消息一致，fatal 才中止运行。
   *
   * @param context - 本次运行上下文，供 Hook 读取身份与元数据。
   * @param message - 刚提交的 assistant 消息。
   * @param signal - 运行取消信号，Hook 应据此尽早放弃。
   */
  onAssistantMessage(
    context: RuntimeContext,
    message: RawMessage,
    signal: AbortSignal,
  ): Promise<void>;
  /**
   * 在 tool 结果消息进入持久上下文后回调；失败语义与 user 消息一致，fatal 才中止运行。
   *
   * @param context - 本次运行上下文，供 Hook 读取身份与元数据。
   * @param message - 刚提交的 tool 消息。
   * @param signal - 运行取消信号，Hook 应据此尽早放弃。
   */
  onToolMessage(
    context: RuntimeContext,
    message: RawMessage,
    signal: AbortSignal,
  ): Promise<void>;
}

/** Pipeline 生命周期 Hook；SDK 提供 NoopPipelineHook，未配置时 PipelineBuilder 使用空 Hook 列表。 */
export interface PipelineHook {
  /**
   * 在节点执行前回调，常用于计时与写入诊断上下文。
   *
   * 失败是**致命**的：抛出会中断正常段，因此它不适合放可忽略的观察逻辑。
   *
   * @param context - 本次运行上下文。
   * @param node - 即将执行的节点。
   * @param signal - 运行取消信号。
   */
  beforeNode(
    context: RuntimeContext,
    node: RuntimeNode,
    signal: AbortSignal,
  ): Promise<void>;
  /**
   * 在节点执行后回调，`error` 为该节点的失败（成功时为 undefined）。
   *
   * 这是**纯观察点**：它的失败被吞掉、不改变主结果——一个诊断 Hook 出问题不该把一次
   * 成功的运行变成失败。因此它只适合写日志、埋点，不适合承载业务副作用。
   *
   * @param context - 本次运行上下文。
   * @param node - 刚刚执行完的节点。
   * @param error - 该节点抛出的错误；节点成功时为 undefined。
   * @param signal - 运行取消信号。
   */
  afterNode(
    context: RuntimeContext,
    node: RuntimeNode,
    error: Error | undefined,
    signal: AbortSignal,
  ): Promise<void>;
  /**
   * 在整条 pipeline 开始前回调。
   *
   * 失败是**致命**的：抛出会直接中断正常段，连第一个节点都不会执行。
   *
   * @param context - 本次运行上下文。
   * @param signal - 运行取消信号。
   */
  onPipelineStart(context: RuntimeContext, signal: AbortSignal): Promise<void>;
  /**
   * 在正常段结束后回调，无论成败都会执行，且运行在独立的清理信号下。
   *
   * `error` 是正常段已归集的失败（全成功时为 undefined）。它的失败会与运行错误一起被汇总抛出，
   * 但不会阻止后续 finally 节点继续清理。
   *
   * @param context - 本次运行上下文；清理进度会回写到 pipelineError。
   * @param error - 正常段已归集的失败；全成功时为 undefined。
   * @param signal - 清理段的独立超时信号，**不是**运行取消信号。
   */
  onPipelineEnd(
    context: RuntimeContext,
    error: Error | undefined,
    signal: AbortSignal,
  ): Promise<void>;
}
