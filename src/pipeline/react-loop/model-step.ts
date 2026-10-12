import type { LlmChunk } from "../../llm/model/model.js";

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new DOMException("operation aborted", "AbortError");
}

/** 主循环取消或失败后尽力关闭模型流，不覆盖原始错误。 */
export async function closeModelIterator(
  iterator: AsyncIterator<LlmChunk>,
): Promise<void> {
  try {
    await iterator.return?.();
  } catch {
    // 主错误或取消发生后，关闭 stream 仅作尽力清理。
  }
}

/**
 * 等待一个模型增量，同时让**空闲超时**和调用方取消都能立即打断等待。
 *
 * 三个 Promise 赛跑：取下一帧、超时、取消。超时按「距上一帧的间隔」计，
 * 所以持续吐字的流不会被总时长限制打断。
 * `timer.unref()` 保证一个待机的超时不会把进程钉在事件循环里；
 * `finally` 里清计时器、摘监听器，避免每次读取都往长生命周期的 signal 上挂监听。
 */
export async function nextModelChunk(
  iterator: AsyncIterator<LlmChunk>,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<IteratorResult<LlmChunk>> {
  if (signal.aborted) throw abortError(signal);
  let timer: NodeJS.Timeout | undefined;
  let onAbort: (() => void) | undefined;
  const timeout = new Promise<never>((_resolve, reject): void => {
    timer = setTimeout(
      (): void =>
        reject(new Error(`LLM stream timed out after ${timeoutMs}ms`)),
      timeoutMs,
    );
    timer.unref();
  });
  const cancelled = new Promise<never>((_resolve, reject): void => {
    onAbort = (): void => reject(abortError(signal));
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([iterator.next(), timeout, cancelled]);
  } finally {
    if (timer) clearTimeout(timer);
    if (onAbort) signal.removeEventListener("abort", onAbort);
  }
}
