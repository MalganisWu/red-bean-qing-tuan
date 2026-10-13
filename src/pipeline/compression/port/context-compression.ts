import type { RuntimeContext } from "../../context/runtime-context.js";
import type { RawMessage } from "../../../protocol/message.js";

/** `RuntimeContext.metadata` 中存放本次运行 token 用量的键；与 execution 侧同名同义。 */
export const TOKENS_USED_METADATA_KEY = "tokens_used";

/**
 * 模型调用前的上下文压缩边界。
 * SDK 默认实现为 DefaultCompressor，由 ReAct 主循环按 RuntimeConfig 构造；宿主也可通过配置直接注入实现。
 * 失败是否降级由 ReAct 主循环决定。
 */
export interface ContextCompressor {
  /**
   * 判断这一轮是否需要触发压缩，**不做任何副作用**。
   *
   * 与 `compress` 分开是为了让主循环在两次调用之间还能做别的取舍，因此判定必须廉价且幂等。
   *
   * @param context - 本次运行的上下文；判定通常只依赖消息，实现可自行决定是否读取。
   * @param messages - 待评估的完整消息序列，超过实现设定的阈值即认为需要压缩。
   * @param signal - 取消信号；已中止时应以取消原因拒绝而不是返回布尔值。
   * @returns 本轮是否需要压缩；压缩被禁用或已明确放弃压缩时为 false。
   */
  shouldCompact(
    context: RuntimeContext,
    messages: readonly RawMessage[],
    signal: AbortSignal,
  ): Promise<boolean>;
  /**
   * 压缩历史消息并返回替换后的序列。
   *
   * 返回的序列必须仍是模型可接受的合法形状——尤其不能把 `assistant(tool_calls)` 与
   * 紧随其后的 tool 结果拆开，否则 provider 会直接拒绝。失败时向上抛出，由主循环决定降级。
   *
   * @param context - 本次运行的上下文，用于取内容引用并发出压缩事件。
   * @param messages - 待压缩的完整消息序列。
   * @param signal - 取消信号；已中止时应以取消原因抛出而不是返回部分结果。
   * @returns 压缩后的消息序列，形状与角色顺序由实现保证合法。
   */
  compress(
    context: RuntimeContext,
    messages: readonly RawMessage[],
    signal: AbortSignal,
  ): Promise<readonly RawMessage[]>;
}
