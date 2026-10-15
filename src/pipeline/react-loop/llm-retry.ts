import type { RuntimeConfig } from "../config/runtime-config.js";
import { isLlmError, LLM_ERROR_KINDS } from "../../llm/error/llm-error.js";

/**
 * 重试与超时的默认值。
 * 上限 10 次、基数 2s、封顶 64s：满打满算约两分钟的退避预算，
 * 够扛过限流和上游抖动，又不至于让一次运行卡到用户以为它死了。
 */
const DEFAULT_MAX_RETRIES = 10;
/** 首次重试的退避基数毫秒数，也是逐次翻倍的起点。 */
const DEFAULT_BACKOFF_BASE_MS = 2_000;
/** 单次退避的上限毫秒数；达到后不再翻倍，避免重试间隔无限增长。 */
const DEFAULT_BACKOFF_CAP_MS = 64_000;
/** 流空闲超时：按「距上一帧的间隔」计，不是整段请求的总时长。 */
const DEFAULT_IDLE_TIMEOUT_MS = 30_000;

/** 单次 ReAct 运行采用的 LLM 重试与空闲超时参数。 */
export interface LlmRunParams {
  /** 最大重试次数；耗尽后仍失败即抛出，0 表示不重试。 */
  readonly maxRetries: number;
  /** 首次重试的退避毫秒数，也是逐次翻倍的起点。 */
  readonly backoffBaseMs: number;
  /** 单次退避的上限毫秒数，达到后不再翻倍。 */
  readonly backoffCapMs: number;
  /** 模型流的空闲超时毫秒数，按「距上一帧的间隔」重新计时。 */
  readonly idleTimeoutMs: number;
}

/**
 * 取一个非负整数配置，非法值退回默认值，负数夹到 0。
 *
 * @param value - 待校验的配置值；只有安全整数才被接受。
 * @param fallback - value 缺失或非整数时使用的默认值。
 * @returns 夹到非负的 value，或 fallback。
 */
function nonNegativeInteger(
  value: number | undefined,
  fallback: number,
): number {
  return value !== undefined && Number.isSafeInteger(value)
    ? Math.max(0, value)
    : fallback;
}

/**
 * 把「秒」为单位的配置换算成毫秒，非法或非正值退回默认毫秒数。
 *
 * 配置对外用秒、内部一律用毫秒，换算集中在此避免各处重复乘 1000 时漏乘。
 *
 * @param value - 以秒为单位的配置值；只有正安全整数才被接受。
 * @param fallbackMs - value 缺失或非正数时使用的默认毫秒数。
 * @returns 换算后的毫秒数，或 fallbackMs。
 */
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
 *
 * @param config - 运行配置；其中的重试与超时字段可能缺失或非法，均按默认值兜底。
 * @returns 本次运行实际采用的重试次数、退避基数与上限、空闲超时（毫秒）。
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
 *
 * @param attempt - 已发生的重试序号，从 0 起；越大退避越久，直到封顶。
 * @param baseMs - 首次重试的退避毫秒数，也是逐次翻倍的起点。
 * @param capMs - 单次退避的上限毫秒数，达到后不再翻倍。
 * @returns 本次重试应等待的毫秒数，介于 baseMs 与 capMs 之间。
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
 *
 * @param delayMs - 等待的毫秒数；到点即正常返回。
 * @param signal - 取消信号；已取消或等待期间被取消都以取消原因拒绝而非静默返回。
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
  // 用 `undefined` 而不是 `void` 作类型参数：本仓 ESLint 不允许 `void` 出现在类型参数位置。
  const {
    promise: slept,
    resolve,
    reject,
  } = Promise.withResolvers<undefined>();
  const timer = setTimeout((): void => resolve(undefined), delayMs);
  timer.unref();
  // 取消时先清掉定时器再以取消原因拒绝，避免等待方被定时器提前唤醒。
  function abortSleep(): void {
    clearTimeout(timer);
    reject(
      signal.reason instanceof Error
        ? signal.reason
        : new DOMException("operation aborted", "AbortError"),
    );
  }
  signal.addEventListener("abort", abortSleep, { once: true });
  await slept;
}

/**
 * 只重试**临时**错误（限流、超时、上游 5xx）；其余错误立即上抛。
 * 重试一个鉴权失败或参数错误，只会把一次配置问题放大成十次无效请求。
 *
 * `sleep` 与 `onRetry` 都是注入的：宿主可以把退避接到自己的调度器上，
 * 测试则能把它换成确定性实现，不必真的等两秒。
 * 最终失败时用 `cause` 保留原始错误，外层才能分辨「重试耗尽」与「首次就永久失败」。
 *
 * @param params - 重试与退避参数，给出最大重试次数与退避区间。
 * @param sleep - 可替换的等待实现，宿主可接自己的调度器、测试可换成确定性实现。
 * @param onRetry - 每次实际重试前的同步通知，传 undefined 则不通知。
 * @param call - 真正发起调用的工厂；每次尝试都会调用它一次。
 * @param signal - 取消信号，透传给 sleep 以便退避等待可被打断。
 * @returns 调用成功时的返回值；重试耗尽或永久错误时抛出带 cause 的 Error。
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
        throw new Error(`LLM 请求失败：${error.message}`, {
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
