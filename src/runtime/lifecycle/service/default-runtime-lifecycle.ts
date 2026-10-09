import type { RuntimeLifecycle } from "../port/runtime-lifecycle.js";

/** 等待存量运行退出并保证底层资源只关闭一次的默认生命周期实现。 */
export class DefaultRuntimeLifecycle implements RuntimeLifecycle {
  readonly #idleWaiters = new Set<() => void>();
  #closing = false;
  #activeRuns = 0;
  #closePromise: Promise<void> | undefined;

  public beginRun(): () => void {
    if (this.#closing) throw new Error("runtime is closed");
    this.#activeRuns += 1;
    let released = false;
    return (): void => {
      if (released) return;
      released = true;
      this.#activeRuns -= 1;
      if (this.#activeRuns !== 0) return;
      for (const resolve of this.#idleWaiters) resolve();
      this.#idleWaiters.clear();
    };
  }

  public async close(
    closeResources: () => Promise<void>,
    signal: AbortSignal,
  ): Promise<void> {
    this.#closing = true;
    if (this.#activeRuns > 0) {
      await raceAbort(
        new Promise<void>((resolve): void => {
          this.#idleWaiters.add(resolve);
        }),
        signal,
      );
    }
    this.#closePromise ??= closeResources();
    await raceAbort(this.#closePromise, signal);
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
