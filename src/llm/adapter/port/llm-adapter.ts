import type { LlmChunk, LlmRequest } from "../../model/model.js";

/**
 * 模型提供方必须实现的最小流式调用 Port。
 * SDK 提供 OpenAiAdapter；高层 Runtime 由宿主通过 AgentRuntimeOptions 注入，低层 Pipeline 由宿主直接组装。
 */
export interface LlmAdapter {
  /**
   * 发起一次流式补全，返回中性 chunk 流的迭代器。
   *
   * 实现必须把厂商错误分类为永久或临时，宿主的重试策略直接依赖该划分：永久错误重试无意义。
   *
   * @param request - 中性 LLM 请求，含消息、工具与生成参数。
   * @param signal - 取消信号，须同时约束建连阶段与流读取阶段。
   * @returns chunk 异步迭代器；厂商协议错误以带内 error chunk 传递而非抛出。
   */
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
