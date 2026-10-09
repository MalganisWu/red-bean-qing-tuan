import type { RuntimeConfig } from "../config/runtime-config.js";
import { isLlmError, LLM_ERROR_KINDS } from "../../llm/error/llm-error.js";

const DEFAULT_MAX_RETRIES = 10;
const DEFAULT_BACKOFF_BASE_MS = 2_000;
const DEFAULT_BACKOFF_CAP_MS = 64_000;
const DEFAULT_IDLE_TIMEOUT_MS = 30_000;

/** 单次 ReAct 运行采用的 LLM 重试与空闲超时参数。 */
export interface LlmRunParams {
  readonly maxRetries: number;
  readonly backoffBaseMs: number;
  readonly backoffCapMs: number;
  readonly idleTimeoutMs: number;
}

function nonNegativeInteger(
  value: number | undefined,
  fallback: number,
): number {
  return value !== undefined && Number.isSafeInteger(value)
    ? Math.max(0, value)
    : fallback;
}

function positiveSeconds(
  value: number | undefined,
  fallbackMs: number,
): number {
  return value !== undefined && Number.isSafeInteger(value) && value > 0
    ? value * 1_000
    : fallbackMs;
}

export function resolveLlmRunParams(config: RuntimeConfig): LlmRunParams {
  return {
    maxRetries: nonNegativeInteger(config.maxLlmRetries, DEFAULT_MAX_RETRIES),
    backoffBaseMs: positiveSeconds(
      config.llmRetryBackoffSeconds,
      DEFAULT_BACKOFF_BASE_MS,
    ),
    backoffCapMs: positiveSeconds(
      config.llmRetryBackoffMaxSeconds,
      DEFAULT_BACKOFF_CAP_MS,
    ),
    idleTimeoutMs: positiveSeconds(
      config.llmTimeoutSeconds,
      DEFAULT_IDLE_TIMEOUT_MS,
    ),
  };
}

export function llmBackoff(
  attempt: number,
  baseMs: number,
  capMs: number,
): number {
  let delayMs = baseMs;
  for (let index = 0; index < attempt && delayMs < capMs; index += 1) {
    delayMs *= 2;
  }
  return Math.min(delayMs, capMs);
}

/** 可替换的可取消等待函数；主要用于宿主调度适配和确定性测试。 */
export type RetrySleep = (
  delayMs: number,
  signal: AbortSignal,
) => Promise<void>;

/** 每次实际重试前触发的同步通知。 */
export type RetryNotification = (attempt: number, maximum: number) => void;

export async function sleepWithSignal(
  delayMs: number,
  signal: AbortSignal,
): Promise<void> {
  if (signal.aborted) {
    throw signal.reason instanceof Error
      ? signal.reason
      : new DOMException("operation aborted", "AbortError");
  }
  await new Promise<void>((resolve, reject): void => {
    const timer = setTimeout(resolve, delayMs);
    timer.unref();
    signal.addEventListener(
      "abort",
      (): void => {
        clearTimeout(timer);
        reject(
          signal.reason instanceof Error
            ? signal.reason
            : new DOMException("operation aborted", "AbortError"),
        );
      },
      { once: true },
    );
  });
}

export async function runWithLlmRetry<TOutput>(
  params: LlmRunParams,
  sleep: RetrySleep,
  onRetry: RetryNotification | undefined,
  call: () => Promise<TOutput>,
  signal: AbortSignal,
): Promise<TOutput> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await call();
    } catch (value: unknown) {
      const error = value instanceof Error ? value : new Error(String(value));
      if (
        attempt >= params.maxRetries ||
        !isLlmError(error, LLM_ERROR_KINDS.TEMPORARY)
      ) {
        throw new Error(`LLM request failed: ${error.message}`, {
          cause: value,
        });
      }
      onRetry?.(attempt + 1, params.maxRetries);
      await sleep(
        llmBackoff(attempt, params.backoffBaseMs, params.backoffCapMs),
        signal,
      );
    }
  }
}
