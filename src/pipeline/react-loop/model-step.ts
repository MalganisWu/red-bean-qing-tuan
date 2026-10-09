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

/** 等待一个模型增量，同时让超时和调用方取消可以立即打断等待。 */
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
