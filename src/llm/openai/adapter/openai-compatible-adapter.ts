import { LLM_ERROR_KINDS, LlmError } from "../../error/llm-error.js";
import type {
  LlmAdapter,
  LlmAdapterFactory,
} from "../../adapter/port/llm-adapter.js";
import type { LlmChunk, LlmRequest } from "../../model/model.js";
import {
  abortError,
  normalizeError,
  openAiHttpError,
  openAiProtocolError,
} from "../error/openai-error-mapper.js";
import { openAiRequestPayload } from "../request/openai-request-mapper.js";
import { parseOpenAiEventStream } from "../stream/openai-stream-parser.js";

const DEFAULT_BASE_URL = "https://api.openai.com/v1";
const DEFAULT_MODEL_NAME = "gpt-4";

/** 可由宿主注入的 fetch 最小契约，便于控制网络实现与测试。 */
export type FetchLike = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

/** OpenAI-compatible Adapter 的构造配置；凭据和网络客户端均由宿主持有并注入。 */
export interface OpenAiAdapterOptions {
  readonly apiKey: string;
  readonly baseUrl?: string | undefined;
  readonly modelName?: string | undefined;
  readonly fetch?: FetchLike | undefined;
}

/** OpenAI-compatible 流式协议 Adapter；请求与响应转换由相邻专责文件完成。 */
export class OpenAiAdapter implements LlmAdapter {
  readonly #apiKey: string;
  readonly #baseUrl: string;
  readonly #modelName: string;
  readonly #fetch: FetchLike;

  public constructor(options: OpenAiAdapterOptions) {
    this.#apiKey = options.apiKey;
    this.#baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
    this.#modelName = options.modelName ?? DEFAULT_MODEL_NAME;
    this.#fetch = options.fetch ?? fetch;
  }

  /**
   * 建连并返回未消费的事件流；响应体的读取发生在调用方消费返回的迭代器时。
   *
   * 错误分成三条通道，宿主的重试策略直接依赖这个划分：
   * - **取消**：`signal.aborted` 时抛原始 reason，与「网络失败」区分开——
   *   取消是调用方的意图，不该被当成可重试的故障。
   * - **临时（TEMPORARY）**：连接层面的失败，以及 `openAiHttpError` 判定为 429/5xx 的响应，可重试。
   * - **永久（PERMANENT）**：base URL 非法、响应没有 body 等协议问题，重试没有意义。
   *
   * 末尾的 `stream` 参数再传一次 signal：建连之后仍要能被取消。
   */
  public async streamCompletion(
    request: LlmRequest,
    signal: AbortSignal,
  ): Promise<AsyncIterable<LlmChunk>> {
    let endpoint: URL;
    try {
      endpoint = new URL(
        `${this.#baseUrl.replace(/\/+$/, "")}/chat/completions`,
      );
    } catch (cause: unknown) {
      throw openAiProtocolError("invalid OpenAI-compatible base URL", cause);
    }
    let response: Response;
    try {
      response = await this.#fetch(endpoint, {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.#apiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(openAiRequestPayload(this.#modelName, request)),
        signal,
      });
    } catch (cause: unknown) {
      if (signal.aborted) throw abortError(signal);
      throw new LlmError(
        LLM_ERROR_KINDS.TEMPORARY,
        new Error(
          `send OpenAI-compatible request: ${normalizeError(cause).message}`,
          { cause },
        ),
      );
    }
    if (!response.ok)
      throw openAiHttpError(response.status, await response.text());
    if (!response.body)
      throw openAiProtocolError("OpenAI-compatible response has no body");
    return parseOpenAiEventStream(response.body, signal);
  }
}

/**
 * 默认工厂：目前只认 `openai`，其他 provider 直接报错而不是回退到某个默认实现。
 * 空串的 baseUrl / modelName 视为「未提供」而落到默认值——
 * 宿主配置里留空的字段不应该把请求打到一个空 URL 上。
 */
export function createDefaultLlmAdapterFactory(): LlmAdapterFactory {
  /** 按 provider 造适配器；认不出的 provider 直接报错，不静默回退到某个默认实现。 */
  function createAdapter(
    provider: string,
    apiKey: string,
    baseUrl: string,
    modelName: string,
  ): LlmAdapter {
    if (provider !== "openai")
      throw new Error(`unsupported provider: ${provider}`);
    return new OpenAiAdapter({
      apiKey,
      ...(baseUrl !== "" ? { baseUrl } : {}),
      ...(modelName !== "" ? { modelName } : {}),
    });
  }
  return createAdapter;
}
