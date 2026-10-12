/**
 * 取消信号的中性小工具，跨能力共享。
 *
 * 放在 `protocol/` 的依据是 `docs/design/architecture.md` 的硬边界：
 * 「`protocol` 和各能力 `port/` 只保存中性类型、接口和**小型纯 helper**，不依赖宿主或具体基础设施」。
 * `pipeline`、`runtime`、`llm` 三者都要用它，而 `llm` 只能依赖 `protocol`，
 * 因此只有这里能被三方共同引用。
 *
 * 不加入 `pipeline/public-api.ts`：它不是公开契约，只是内部实现共用的助手。
 */

/** 取取消原因；优先沿用 `signal.reason`，不把它换成通用文案。 */
export function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new DOMException("operation aborted", "AbortError");
}

/**
 * 在 `signal` 中止时以取消原因拒绝，否则等待 `operation`。
 *
 * 两处细节是为了不留悬挂监听：前置的 `signal.aborted` 检查直接短路，
 * `finally` 里必须摘掉监听器——等待方已经离开，监听器再挂在长生命周期的 signal 上就是累积泄漏。
 */
export async function raceAbort<TOutput>(
  operation: Promise<TOutput>,
  signal: AbortSignal,
): Promise<TOutput> {
  if (signal.aborted) throw abortError(signal);
  const { promise: cancelled, reject } = Promise.withResolvers<never>();
  const onAbort = (): void => reject(abortError(signal));
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    return await Promise.race([operation, cancelled]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}
