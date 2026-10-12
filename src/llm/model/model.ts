import type { RawMessage } from "../../protocol/message.js";
import type { ToolCall } from "../../protocol/tool-call.js";
import type { ToolSchema } from "../../protocol/tool-schema.js";

/** Runtime 可跨模型适配器传递的中性生成参数。 */
export interface ModelParams {
  readonly temperature?: number | undefined;
  readonly maxTokens?: number | undefined;
  readonly contextWindow?: number | undefined;
  readonly thinking?: boolean | undefined;
}

/** 一次模型调用返回的标准 Token 用量。 */
export interface TokenUsage {
  readonly promptTokens: number;
  readonly completionTokens: number;
  readonly totalTokens: number;
}

/** 传给 LlmAdapter 的完整中性请求，不暴露厂商 wire DTO。 */
export interface LlmRequest {
  readonly messages: readonly RawMessage[];
  readonly tools: readonly ToolSchema[];
  readonly params: ModelParams;
}

/**
 * 模型流的单个增量；厂商响应必须先转换为该结构。
 *
 * `error` 是**带内**错误通道：设置它表示「这一帧是错的」，流本身仍会正常结束。
 * 厂商侧的协议错误（JSON 解析失败、字段类型不对）走这条通道而不是抛出，
 * 消费者因此只需要处理一种终止方式。`content: null` 是合法的——工具调用轮次就没有正文。
 */
export interface LlmChunk {
  readonly content: string | null;
  readonly reasoningContent?: string | null | undefined;
  readonly toolCalls?: readonly ToolCall[] | undefined;
  readonly finishReason?: string | null | undefined;
  readonly usage?: TokenUsage | undefined;
  readonly error?: Error | undefined;
}
