/**
 * 管理 Runtime 接受运行、等待空闲和关闭资源的时序。
 * `beginRun` 返回的释放函数必须在调用方 finally 中执行。
 * SDK 默认实现为 DefaultRuntimeLifecycle，由 control-plane-composition.ts 显式组装。
 */
export interface RuntimeLifecycle {
  /**
   * 登记一次运行，返回结束本次记账的释放函数。
   *
   * 已进入关闭态时必须抛错而不是默默接纳，否则 close 可能永远等不到这次运行退出。
   *
   * @returns 释放函数；必须在调用方 finally 中执行，且允许重复调用
   */
  beginRun(): () => void;
  /**
   * 停止接纳新运行、等待存量运行释放后，再执行一次 `closeResources`。
   *
   * @param closeResources - 真正释放资源的回调；实现须保证并发或重复 close 时它只被执行一次
   * @param signal - 关闭的取消信号；只用于中止等待，不取消已经启动的资源释放
   */
  close(
    closeResources: () => Promise<void>,
    signal: AbortSignal,
  ): Promise<void>;
}
