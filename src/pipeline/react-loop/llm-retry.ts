import type { RuntimeConfig } from "../config/runtime-config.js";
import { isLlmError, LLM_ERROR_KINDS } from "../../llm/error/llm-error.js";

/**
 * 重试与超时的默认值。
 * 上限 10 次、基数 2s、封顶 64s：满打满算约两分钟的退避预算，
 * 够扛过限流和上游抖动，又不至于让一次运行卡到用户以为它死了。
 */
const DEFAULT_MAX_RETRIES = 10;
const DEFAULT_BACKOFF_BASE_MS = 2_000;
const DEFAULT_BACKOFF_CAP_MS = 64_000;
/** 流空闲超时：按「距上一帧的间隔」计，不是整段请求的总时长。 */
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

/**
 * 把配置收敛成一次运行实际使用的参数。
 * 非法值（非整数、负数、0）一律退回默认值而不是抛错：运行时的容错优先于配置的严格性，
 * 一个写错的退避秒数不该让整个 Agent 起不来。
 */
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

/**
 * 指数退避：基数逐次翻倍，封顶后不再增长。
 * 用循环累乘而不是 `base * 2 ** attempt`，是为了在高重试次数下也不会先把中间值撑到溢出。
 */
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

/**
 * 可被取消的等待。
 * `timer.unref()` 是必要的：一次待机的重试不应把 Node 进程钉在事件循环里，
 * 否则宿主在等退避时无法正常退出。
 */
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

/**
 * 只重试**临时**错误（限流、超时、上游 5xx）；其余错误立即上抛。
 * 重试一个鉴权失败或参数错误，只会把一次配置问题放大成十次无效请求。
 *
 * `sleep` 与 `onRetry` 都是注入的：宿主可以把退避接到自己的调度器上，
 * 测试则能把它换成确定性实现，不必真的等两秒。
 * 最终失败时用 `cause` 保留原始错误，外层才能分辨「重试耗尽」与「首次就永久失败」。
 */
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
