import type { ThreadExecutionCoordinator } from "../port/thread-execution-coordinator.js";

/**
 * 使用进程内 Promise 队列串行化同一 Thread 的默认实现。
 *
 * 队列是一条 `previous → current` 的 Promise 链：每次 acquire 把自己接到当前链尾
 * （`tail = previous.then(() => current)`），后来的请求因此会等前面全部释放。
 * 释放是幂等的，且只有「自己就是当前链尾」时才把 Map 里的指针摘掉，
 * 避免把后来者刚接上的尾巴误删。
 *
 * **Map 里的指针是该 thread「是否还有人」的唯一判据，摘除条件因此必须保守。**
 * 关键在链尾 Promise 要到前面全部释放才落定：它未落定就代表链上还有人。
 * - 正常释放：自己就是链尾，说明没有后来者，链条确实排空，可摘。
 * - 排队者被取消：**只有入队时队里本就没人**（`previousTail === undefined`）才可摘；
 *   否则后来的 acquire 会读到空的 Map、拿到一个已 resolve 的 `previous` 而立即获锁——
 *   同一 thread 上出现并发执行，串行化在该窗口内不成立。
 *   取消者仍要 `releaseCurrent()` 解开自己那一环，好让排在它后面的请求继续前进。
 *   保留一个已落定的链尾是安全的：它只表示「无人在运行」，后续 acquire 仍会先接链、
 *   再在自己的释放路径上摘除。
 */
export class DefaultThreadExecutionCoordinator implements ThreadExecutionCoordinator {
  readonly #threadTails = new Map<string, Promise<void>>();

  public async acquire(
    threadId: string,
    signal: AbortSignal,
  ): Promise<() => void> {
    // 空 threadId 表示不做串行化（无 Store 的单次调用场景），直接发一个空释放函数。
    if (threadId === "") return (): void => {};

    const previousTail = this.#threadTails.get(threadId);
    const previous = previousTail ?? Promise.resolve();
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
      // 取消/放弃：先解开自己那一环，让排在后面的请求不为这个已经退出的等待者空等。
      releaseCurrent();
      // 摘指针等于断言「链上已无人在执行」，而「我是链尾」并不足以支撑这个断言
      // （链尾要等前面全部释放才落定）。因此这里额外要求入队时队里本就没人，见类注释。
      if (
        previousTail === undefined &&
        this.#threadTails.get(threadId) === tail
      ) {
        this.#threadTails.delete(threadId);
      }
      throw error;
    }

    let released = false;
    /** 释放：幂等，且不会误删别人的尾巴（只有自己仍是链尾时才摘指针）。 */
    const release = (): void => {
      if (released) return;
      released = true;
      releaseCurrent();
      if (this.#threadTails.get(threadId) === tail) {
        this.#threadTails.delete(threadId);
      }
    };
    return release;
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
