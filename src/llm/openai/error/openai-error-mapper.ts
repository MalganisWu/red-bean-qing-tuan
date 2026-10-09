import { LLM_ERROR_KINDS, LlmError } from "../../error/llm-error.js";

export function normalizeError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

export function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new DOMException("operation aborted", "AbortError");
}

export function openAiProtocolError(
  message: string,
  cause?: unknown,
): LlmError {
  const error = new Error(message, cause === undefined ? undefined : { cause });
  return new LlmError(LLM_ERROR_KINDS.PERMANENT, error);
}

/** 将 HTTP 状态映射为稳定的临时或永久 LLM 错误。 */
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
