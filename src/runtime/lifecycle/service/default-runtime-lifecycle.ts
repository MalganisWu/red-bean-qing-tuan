import type { RuntimeLifecycle } from "../port/runtime-lifecycle.js";

/**
 * 等待存量运行退出并保证底层资源只关闭一次的默认生命周期实现。
 *
 * 关闭分两段，顺序不能反：
 * 1. **停止接纳**：`#closing` 一置位，后续 `beginRun` 立即抛错（而不是悄悄放进来）。
 * 2. **排空**：等已在跑的运行全部释放，再真正关资源。
 *    不等就关，会让正在进行的运行在使用已释放的连接池时失败。
 *
 * 「只关一次」由 `#closePromise ??=` 保证：并发或重复的 close 共享同一个 Promise，
 * 而不是各自去关一遍。`#closing` 一旦为真就不会复位——关闭是不可逆的终态。
 */
export class DefaultRuntimeLifecycle implements RuntimeLifecycle {
  readonly #idleWaiters = new Set<() => void>();
  #closing = false;
  #activeRuns = 0;
  #closePromise: Promise<void> | undefined;

  /**
   * 登记一次运行并返回幂等的结束函数。
   * 计数归零时唤醒全部等待者——用「集合」而不是单个 resolve，是为了容纳多个并发 close。
   */
  public beginRun(): () => void {
    if (this.#closing) throw new Error("runtime is closed");
    this.#activeRuns += 1;
    let released = false;
    /** 结束本次运行记账：幂等；最后一个运行结束时唤醒所有等待空转的调用方。 */
    const endRun = (): void => {
      if (released) return;
      released = true;
      this.#activeRuns -= 1;
      if (this.#activeRuns !== 0) return;
      for (const resolve of this.#idleWaiters) resolve();
      this.#idleWaiters.clear();
    };
    return endRun;
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
    // 无论有多少个调用者，closeResources 只被调用一次。
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
  const { promise: cancellation, reject } = Promise.withResolvers<never>();
  const onAbort = (): void => reject(abortError(signal));
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    return await Promise.race([operation, cancellation]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}
