/**
 * 管理 Runtime 接受运行、等待空闲和关闭资源的时序。
 * `beginRun` 返回的释放函数必须在调用方 finally 中执行。
 * SDK 默认实现为 DefaultRuntimeLifecycle，由 control-plane-composition.ts 显式组装。
 */
export interface RuntimeLifecycle {
  beginRun(): () => void;
  close(
    closeResources: () => Promise<void>,
    signal: AbortSignal,
  ): Promise<void>;
}
