import type { LlmChunk } from "../../llm/model/model.js";
/**
 * 主循环取消或失败后尽力关闭模型流，不覆盖原始错误。
 *
 * @param iterator - 模型流迭代器；关闭失败会被吞掉，因为它只在清理路径上调用。
 */
export async function closeModelIterator(
  iterator: AsyncIterator<LlmChunk>,
): Promise<void> {
  try {
    await iterator.return?.();
  } catch {
    // 主错误或取消发生后，关闭 stream 仅作尽力清理。
  }
}
import { abortError } from "../../protocol/abort-signal.js";

/**
 * 等待一个模型增量，同时让**空闲超时**和调用方取消都能立即打断等待。
 *
 * 三个 Promise 赛跑：取下一帧、超时、取消。超时按「距上一帧的间隔」计，
 * 所以持续吐字的流不会被总时长限制打断。
 * `timer.unref()` 保证一个待机的超时不会把进程钉在事件循环里；
 * `finally` 里清计时器、摘监听器，避免每次读取都往长生命周期的 signal 上挂监听。
 *
 * @param iterator - 模型流迭代器；本函数只取一帧，不负责关闭它。
 * @param timeoutMs - 空闲超时毫秒数，按距上一帧的间隔计，而非整段请求的总时长。
 * @param signal - 调用方取消信号；已取消或等待期间取消都以取消原因拒绝。
 * @returns 下一帧的迭代结果；`done` 为 true 表示流正常结束。
 */
export async function nextModelChunk(
  iterator: AsyncIterator<LlmChunk>,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<IteratorResult<LlmChunk>> {
  if (signal.aborted) throw abortError(signal);
  const { promise: timeout, reject: rejectTimeout } =
    Promise.withResolvers<never>();
  const timer = setTimeout(
    (): void =>
      rejectTimeout(new Error(`LLM stream timed out after ${timeoutMs}ms`)),
    timeoutMs,
  );
  timer.unref();
  const { promise: cancelled, reject: rejectAborted } =
    Promise.withResolvers<never>();
  const onAbort = (): void => rejectAborted(abortError(signal));
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    return await Promise.race([iterator.next(), timeout, cancelled]);
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", onAbort);
  }
}
