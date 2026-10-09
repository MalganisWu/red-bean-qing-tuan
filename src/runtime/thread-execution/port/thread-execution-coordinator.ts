/**
 * 协调同一 Thread 的运行顺序。
 *
 * 不同 Thread 可以并行；同一 Thread 必须串行，避免并发运行基于同一份
 * Checkpoint 产生互相覆盖的结果。SDK 默认实现为 DefaultThreadExecutionCoordinator，
 * 由 control-plane-composition.ts 显式组装。
 */
export interface ThreadExecutionCoordinator {
  acquire(threadId: string, signal: AbortSignal): Promise<() => void>;
}
