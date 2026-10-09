import type { LlmChunk, LlmRequest } from "../../model/model.js";

/**
 * 模型提供方必须实现的最小流式调用 Port。
 * SDK 提供 OpenAiAdapter；高层 Runtime 由宿主通过 AgentRuntimeOptions 注入，低层 Pipeline 由宿主直接组装。
 */
export interface LlmAdapter {
  streamCompletion(
    request: LlmRequest,
    signal: AbortSignal,
  ): Promise<AsyncIterable<LlmChunk>>;
}

/** 由宿主按 provider 配置创建 Adapter；SDK 不维护全局 provider 注册表。 */
export type LlmAdapterFactory = (
  provider: string,
  apiKey: string,
  baseUrl: string,
  modelName: string,
) => LlmAdapter;
