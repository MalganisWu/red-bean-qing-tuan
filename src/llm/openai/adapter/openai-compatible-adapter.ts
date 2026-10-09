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

export function createDefaultLlmAdapterFactory(): LlmAdapterFactory {
  return (provider, apiKey, baseUrl, modelName): LlmAdapter => {
    if (provider !== "openai")
      throw new Error(`unsupported provider: ${provider}`);
    return new OpenAiAdapter({
      apiKey,
      ...(baseUrl !== "" ? { baseUrl } : {}),
      ...(modelName !== "" ? { modelName } : {}),
    });
  };
}
