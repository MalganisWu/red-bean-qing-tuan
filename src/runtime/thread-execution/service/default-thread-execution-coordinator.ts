import type { ThreadExecutionCoordinator } from "../port/thread-execution-coordinator.js";

/**
 * 使用进程内 Promise 队列串行化同一 Thread 的默认实现。
 *
 * 队列是一条 `previous → current` 的 Promise 链：每次 acquire 把自己接到当前链尾
 * （`tail = previous.then(() => current)`），后来的请求因此会等前面全部释放。
 * 释放是幂等的，且只有「自己就是当前链尾」时才把 Map 里的指针摘掉，
 * 避免把后来者刚接上的尾巴误删。
 *
 * ⚠️ **取消路径会让这条链断开**：等待中的 acquire 被取消时，catch 分支会
 * `releaseCurrent()` 并把队尾指针从 Map 摘掉。若此刻链上仍有**正在执行**的持有者，
 * 下一个 acquire 读到的 `previous` 就是一个已 resolve 的 Promise，于是立即拿到锁——
 * 同一 thread 上出现并发执行，本类声称的串行化在该窗口内不成立。
 * 最小触发顺序：A 持锁 → B 排队 → B 取消 → 等一个宏任务让 B 的 catch 跑完 → C 申请 ⇒ C 立即获得。
 *
 * 修复方向是仅在「链上无人在执行」时才摘指针（取消者仍需 releaseCurrent 让 `tail` 链条解开），
 * 但那是行为改动，不在注释补全的范围内，另行决策。
 */
export class DefaultThreadExecutionCoordinator implements ThreadExecutionCoordinator {
  readonly #threadTails = new Map<string, Promise<void>>();

  public async acquire(
    threadId: string,
    signal: AbortSignal,
  ): Promise<() => void> {
    // 空 threadId 表示不做串行化（无 Store 的单次调用场景），直接发一个空释放函数。
    if (threadId === "") return (): void => {};

    const previous = this.#threadTails.get(threadId) ?? Promise.resolve();
    let releaseCurrent: () => void = (): void => {};
    const current = new Promise<void>((resolve): void => {
      releaseCurrent = resolve;
    });
    // 先接链尾再等待：这样本次请求已经排在队里，别人能看到它。
    const tail = previous.then((): Promise<void> => current);
    this.#threadTails.set(threadId, tail);

    try {
      await raceAbort(previous, signal);
    } catch (error: unknown) {
      // 取消/放弃：解开自己那一环并从 Map 摘指针。见类注释的 ⚠️——
      // 这里的摘除条件（「我是链尾」）不足以判断「链上已无人在执行」。
      releaseCurrent();
      if (this.#threadTails.get(threadId) === tail) {
        this.#threadTails.delete(threadId);
      }
      throw error;
    }

    // 释放幂等：重复调用不会二次解开链条，也不会误删别人的尾巴。
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
