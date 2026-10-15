// 取消信号的中性小工具，跨能力共享。
//
// 放在 `protocol/` 的依据是 `docs/design/architecture.md` 的硬边界：
// 「`protocol` 和各能力 `port/` 只保存中性类型、接口和**小型纯 helper**，不依赖宿主或具体基础设施」。
// `pipeline`、`runtime`、`llm` 三者都要用它，而 `llm` 只能依赖 `protocol`，
// 因此只有这里能被三方共同引用。
//
// 不加入 `pipeline/public-api.ts`：它不是公开契约，只是内部实现共用的助手。

/**
 * 取取消原因；优先沿用 `signal.reason`，不把它换成通用文案。
 *
 * @param signal - 待取原因的取消信号；其 `reason` 不是 Error 时才替换成通用 AbortError。
 * @returns 取消原因本身；`reason` 非 Error 时返回兜底的 `DOMException`，原始信息在此丢失。
 */
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
 *
 * @param operation - 被等待的实际操作；它不会被取消，只是取消后不再等它的结果。
 * @param signal - 触发取消的信号；`aborted` 时立即短路抛错，否则在返回前（含拒绝路径）摘掉监听器。
 * @returns `operation` 的结果；`signal` 先中止时则以取消原因拒绝，不会返回半成品。
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
