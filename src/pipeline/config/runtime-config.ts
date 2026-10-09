import type { ContextCompressor } from "../compression/port/context-compression.js";
import type { PostCompactRestorer } from "../compression/port/content-restoration.js";

/** ReAct 上下文压缩策略；Runtime 门面复用该中性配置。 */
export interface CompressionConfig {
  readonly enabled?: boolean | undefined;
  readonly compressor?: ContextCompressor | undefined;
  readonly restorer?: PostCompactRestorer | undefined;
  readonly triggerThreshold?: number | undefined;
  readonly summaryPrompt?: string | undefined;
  readonly keepRecent?: number | undefined;
  readonly idleTimeoutSeconds?: number | undefined;
}

/** Pipeline 执行预算与重试配置，不包含产品或持久化字段。 */
export interface RuntimeConfig {
  readonly maxToolIterations?: number | undefined;
  readonly toolTimeoutSeconds?: number | undefined;
  readonly maxConcurrentTools?: number | undefined;
  readonly maxLlmRetries?: number | undefined;
  readonly llmRetryBackoffSeconds?: number | undefined;
  readonly llmRetryBackoffMaxSeconds?: number | undefined;
  readonly llmTimeoutSeconds?: number | undefined;
  readonly compression?: CompressionConfig | undefined;
}
