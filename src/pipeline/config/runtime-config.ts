import type { ContextCompressor } from "../compression/port/context-compression.js";
import type { PostCompactRestorer } from "../compression/port/content-restoration.js";

/** ReAct 上下文压缩策略；Runtime 门面复用该中性配置。 */
export interface CompressionConfig {
  /** 是否启用自动压缩；只有显式设为 true 才会压缩，其余取值一律视为不压缩。 */
  readonly enabled?: boolean | undefined;
  /** 自定义压缩器；省略时由 ReAct 主循环按本配置构造 SDK 默认实现。 */
  readonly compressor?: ContextCompressor | undefined;
  /** 压缩后的内容恢复器；省略时不恢复内容引用，摘要之外的内容不回流上下文。 */
  readonly restorer?: PostCompactRestorer | undefined;
  /** 触发压缩的 Token 阈值；省略时按模型声明的上下文窗口推算，窗口未知则不自动压缩。 */
  readonly triggerThreshold?: number | undefined;
  /** 追加到内置摘要提示词末尾的自定义指令；为空则只用内置提示词。 */
  readonly summaryPrompt?: string | undefined;
  /** 压缩时保留的最近消息条数；默认实现还会额外保住本次运行正在处理的消息。 */
  readonly keepRecent?: number | undefined;
  /** 摘要流的空闲超时秒数；按「距上一帧的间隔」计，不是整段摘要的总时长。 */
  readonly idleTimeoutSeconds?: number | undefined;
}

/** Pipeline 执行预算与重试配置，不包含产品或持久化字段。 */
export interface RuntimeConfig {
  /** 单次运行的最大「模型 → 工具」往返轮次，防止模型陷入工具调用死循环耗尽预算。 */
  readonly maxToolIterations?: number | undefined;
  /** 单个工具执行的超时秒数；超时只中止该工具并回一条错误结果，不影响整次运行。 */
  readonly toolTimeoutSeconds?: number | undefined;
  /** 一批工具的最大并发数；缺省或非法取值时不限并发，直接按调用数量并发。 */
  readonly maxConcurrentTools?: number | undefined;
  /** LLM 请求的最大重试次数；只对限流、超时、上游 5xx 这类临时错误生效。 */
  readonly maxLlmRetries?: number | undefined;
  /** 重试退避的基数秒数，每次重试逐次翻倍，直到撞上退避上限。 */
  readonly llmRetryBackoffSeconds?: number | undefined;
  /** 单次退避的上限秒数；达到后不再翻倍，避免重试间隔无限增长。 */
  readonly llmRetryBackoffMaxSeconds?: number | undefined;
  /** 模型流的空闲超时秒数；卡住的流会阻塞整个 ReAct 循环，宁可失败也不无限等待。 */
  readonly llmTimeoutSeconds?: number | undefined;
  /** 上下文压缩策略；省略时按默认值处理，即不启用自动压缩。 */
  readonly compression?: CompressionConfig | undefined;
}
