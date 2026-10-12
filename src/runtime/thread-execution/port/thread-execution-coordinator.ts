/**
 * 协调同一 Thread 的运行顺序。
 *
 * 不同 Thread 可以并行；同一 Thread 必须串行，避免并发运行基于同一份
 * Checkpoint 产生互相覆盖的结果。SDK 默认实现为 DefaultThreadExecutionCoordinator，
 * 由 control-plane-composition.ts 显式组装。
 *
 * `acquire` 返回的释放函数**必须在调用方的 finally 中执行**：漏掉会把该 thread 永久卡住，
 * 后续所有请求都排在它后面。等待期间 `signal` 触发则 `acquire` 抛错且不占用槽位。
 *
 * ⚠️ 默认实现目前在「排队者被取消」后会失去串行保证，
 * 详见 `DefaultThreadExecutionCoordinator` 的类注释。
 */
export interface ThreadExecutionCoordinator {
  acquire(threadId: string, signal: AbortSignal): Promise<() => void>;
}
