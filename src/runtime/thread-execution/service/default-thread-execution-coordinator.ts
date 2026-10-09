import type { ThreadExecutionCoordinator } from "../port/thread-execution-coordinator.js";

/** 使用进程内 Promise 队列串行化同一 Thread 的默认实现。 */
export class DefaultThreadExecutionCoordinator implements ThreadExecutionCoordinator {
  readonly #threadTails = new Map<string, Promise<void>>();

  public async acquire(
    threadId: string,
    signal: AbortSignal,
  ): Promise<() => void> {
    if (threadId === "") return (): void => {};

    const previous = this.#threadTails.get(threadId) ?? Promise.resolve();
    let releaseCurrent: () => void = (): void => {};
    const current = new Promise<void>((resolve): void => {
      releaseCurrent = resolve;
    });
    const tail = previous.then((): Promise<void> => current);
    this.#threadTails.set(threadId, tail);

    try {
      await raceAbort(previous, signal);
    } catch (error: unknown) {
      releaseCurrent();
      if (this.#threadTails.get(threadId) === tail) {
        this.#threadTails.delete(threadId);
      }
      throw error;
    }

    let released = false;
    return (): void => {
      if (released) return;
      released = true;
      releaseCurrent();
      if (this.#threadTails.get(threadId) === tail) {
        this.#threadTails.delete(threadId);
      }
    };
  }
}

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new DOMException("operation aborted", "AbortError");
}

async function raceAbort<TOutput>(
  operation: Promise<TOutput>,
  signal: AbortSignal,
): Promise<TOutput> {
  if (signal.aborted) throw abortError(signal);
  let onAbort: (() => void) | undefined;
  const cancellation = new Promise<never>((_resolve, reject): void => {
    onAbort = (): void => reject(abortError(signal));
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([operation, cancellation]);
  } finally {
    if (onAbort) signal.removeEventListener("abort", onAbort);
  }
}
