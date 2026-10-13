import type { RawMessage } from "../../protocol/message.js";
import type { ToolCall } from "../../protocol/tool-call.js";
import type { ToolSchema } from "../../protocol/tool-schema.js";

/** Runtime 可跨模型适配器传递的中性生成参数。 */
export interface ModelParams {
  /** 采样温度；未设置表示交由厂商默认值，适配器不会发送该字段。 */
  readonly temperature?: number | undefined;
  /** 单次补全的最大输出 token 数；未设置表示交给厂商默认值。 */
  readonly maxTokens?: number | undefined;
  /** 模型上下文窗口大小；供压缩策略估算阈值，不发送给厂商。 */
  readonly contextWindow?: number | undefined;
  /** 是否开启推理模式；未设置表示不发送该字段，由厂商决定默认行为。 */
  readonly thinking?: boolean | undefined;
}

/** 一次模型调用返回的标准 Token 用量。 */
export interface TokenUsage {
  /** 输入侧 token 数，含历史消息与工具 schema。 */
  readonly promptTokens: number;
  /** 输出侧 token 数，含正文与工具调用参数。 */
  readonly completionTokens: number;
  /** 厂商上报的总 token 数，用于计费与配额；不保证等于前两者之和。 */
  readonly totalTokens: number;
}

/** 传给 LlmAdapter 的完整中性请求，不暴露厂商 wire DTO。 */
export interface LlmRequest {
  /** 按时间顺序排列的对话消息，含系统提示与往轮工具结果。 */
  readonly messages: readonly RawMessage[];
  /** 本轮可用的工具声明；为空表示纯文本对话，适配器不发送 `tools` 字段。 */
  readonly tools: readonly ToolSchema[];
  /** 生成参数；各字段独立判空，未设置的字段不会出现在 wire 上。 */
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
  /** 正文增量；`null` 表示本帧没有正文（工具调用轮次即如此）。 */
  readonly content: string | null;
  /** 推理过程增量，与正文分开传递；未设置表示该模型或该帧不产出推理内容。 */
  readonly reasoningContent?: string | null | undefined;
  /** 本帧携带的工具调用分片；多帧需按 `index` 归并成完整调用。 */
  readonly toolCalls?: readonly ToolCall[] | undefined;
  /** 结束原因（如 `stop`、`tool_calls`）；未设置表示流尚未结束。 */
  readonly finishReason?: string | null | undefined;
  /** 本帧的 token 用量；通常只在流末尾出现一帧。 */
  readonly usage?: TokenUsage | undefined;
  /** 带内错误；设置它表示本帧失败但流仍正常结束，消费者无需额外 try/catch。 */
  readonly error?: Error | undefined;
}
