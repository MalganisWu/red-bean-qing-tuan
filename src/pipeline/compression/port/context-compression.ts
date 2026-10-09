import type { RuntimeContext } from "../../context/runtime-context.js";
import type { RawMessage } from "../../../protocol/message.js";

export const TOKENS_USED_METADATA_KEY = "tokens_used";

/**
 * 模型调用前的上下文压缩边界。
 * SDK 默认实现为 DefaultCompressor，由 ReAct 主循环按 RuntimeConfig 构造；宿主也可通过配置直接注入实现。
 * 失败是否降级由 ReAct 主循环决定。
 */
export interface ContextCompressor {
  shouldCompact(
    context: RuntimeContext,
    messages: readonly RawMessage[],
    signal: AbortSignal,
  ): Promise<boolean>;
  compress(
    context: RuntimeContext,
    messages: readonly RawMessage[],
    signal: AbortSignal,
  ): Promise<readonly RawMessage[]>;
}
