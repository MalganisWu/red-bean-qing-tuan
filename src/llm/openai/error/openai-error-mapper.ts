import { LLM_ERROR_KINDS, LlmError } from "../../error/llm-error.js";

/** 把任意抛出物统一成 Error；非 Error 一律 `String(...)`，不做结构探测。 */
export function normalizeError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

/** 优先沿用 `signal.reason`：调用方用 `AbortController.abort(customReason)` 传进来的原因不该被抹掉。 */
export function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new DOMException("operation aborted", "AbortError");
}

/**
 * 协议层错误一律是**永久**的：provider 回了一个解析不了或形状不对的响应，
 * 原样重试只会得到同样的结果，重试反而会把一次配置错误放大成持续的无效请求。
 */
export function openAiProtocolError(
  message: string,
  cause?: unknown,
): LlmError {
  const error = new Error(message, cause === undefined ? undefined : { cause });
  return new LlmError(LLM_ERROR_KINDS.PERMANENT, error);
}

/**
 * 将 HTTP 状态映射为稳定的临时或永久 LLM 错误。
 *
 * 这个二分类就是整个 SDK 的重试策略分界线：`429` 与 `5xx` 是**临时**（限流、上游抖动，
 * 退避后值得再试），其余 4xx 是**永久**（鉴权、参数、配额耗尽——重试不会变好）。
 * 改这里的映射等于改所有宿主的重试行为。
 */
export function openAiHttpError(
  status: number,
  responseBody: string,
): LlmError {
  const kind =
    status === 429 || status >= 500
      ? LLM_ERROR_KINDS.TEMPORARY
      : LLM_ERROR_KINDS.PERMANENT;
  return new LlmError(
    kind,
    new Error(`OpenAI-compatible API error ${status}: ${responseBody}`),
  );
}
