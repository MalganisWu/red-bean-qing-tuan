import type { RuntimeLifecycle } from "../port/runtime-lifecycle.js";
import { raceAbort } from "../../../protocol/abort-signal.js";

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
  /** 等运行计数归零的挂起者；用集合容纳多个并发 close，计数归零时全部唤醒。 */
  readonly #idleWaiters = new Set<() => void>();
  /** 是否已停止接纳新运行；一旦置真不复位，关闭是不可逆的终态。 */
  #closing = false;
  /** 当前在跑的运行数；`beginRun` 加一、释放函数减一，归零即唤醒等待者。 */
  #activeRuns = 0;
  /** 首次 close 时创建的资源释放 Promise；后续并发调用复用它，保证资源只关一次。 */
  #closePromise: Promise<void> | undefined;

  /**
   * 登记一次运行并返回幂等的结束函数。
   * 计数归零时唤醒全部等待者——用「集合」而不是单个 resolve，是为了容纳多个并发 close。
   * @returns 结束本次运行记账的回调；重复调用无副作用，但必须被调用，否则 close 会一直等待。
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

  /**
   * 停止接纳新运行、排空存量运行，再释放底层资源。
   *
   * 两步顺序不可颠倒（见类注释）：先置 `#closing` 挡住后续 `beginRun`，再等已在跑的运行退出。
   * 并发或重复调用共享同一次资源释放，`closeResources` 只会被执行一遍。
   * @param closeResources - 真正释放资源的回调；无论多少调用方并发 close，它都只被调用一次。
   * @param signal - 关闭的取消信号；只用于中止等待，不会取消已经启动的 closeResources。
   */
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
