/**
 * 协调同一 Thread 的运行顺序。
 *
 * 不同 Thread 可以并行；同一 Thread 必须串行，避免并发运行基于同一份
 * Checkpoint 产生互相覆盖的结果。SDK 默认实现为 DefaultThreadExecutionCoordinator，
 * 由 control-plane-composition.ts 显式组装。
 *
 * `acquire` 返回的释放函数**必须在调用方的 finally 中执行**：漏掉会把该 thread 永久卡住，
 * 后续所有请求都排在它后面。等待期间 `signal` 触发则 `acquire` 抛错且不占用槽位，
 * 也不会让排在后面的请求越过仍在运行的持有者。
 */
export interface ThreadExecutionCoordinator {
  /**
   * 取得该 thread 的串行执行权，返回幂等的释放函数。
   *
   * @param threadId - 串行化键；相同值的调用按入队顺序依次取得执行权
   * @param signal - 排队期间的取消信号；中止会解开自己占的链环，让后面的请求继续前进
   * @returns 释放执行权的回调；必须在调用方 finally 中执行，且允许重复调用
   */
  acquire(threadId: string, signal: AbortSignal): Promise<() => void>;
}
