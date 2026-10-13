import type { RuntimeLifecycle } from "./lifecycle/port/runtime-lifecycle.js";
import { DefaultRuntimeLifecycle } from "./lifecycle/service/default-runtime-lifecycle.js";
import type { ResumeReceiptStore } from "./resume-receipt/port/resume-receipt-store.js";
import { MemoryResumeReceiptStore } from "./resume-receipt/service/memory-resume-receipt-store.js";
import type { ThreadExecutionCoordinator } from "./thread-execution/port/thread-execution-coordinator.js";
import { DefaultThreadExecutionCoordinator } from "./thread-execution/service/default-thread-execution-coordinator.js";

/** Runtime 内部三个独立状态所有者的组装结果，不向业务层暴露可变容器。 */
export interface RuntimeControlPlane {
  /** 运行计数与关闭时序的状态所有者，默认实现是 DefaultRuntimeLifecycle。 */
  readonly lifecycle: RuntimeLifecycle;
  /** 逐 thread 串行化的状态所有者，默认实现是 DefaultThreadExecutionCoordinator。 */
  readonly threadExecution: ThreadExecutionCoordinator;
  /** resume 幂等收据的状态所有者，默认实现是 MemoryResumeReceiptStore。 */
  readonly resumeReceipts: ResumeReceiptStore;
}

/**
 * 创建并明确绑定 Runtime 内部三个状态所有者。
 *
 * 三者互不依赖，各自管一份进程内状态：生命周期（运行计数与关闭）、
 * 逐 thread 串行化（Promise 队列）、resume 幂等收据（Map）。
 * 它们都是**进程内**实现，跨实例共享状态必须由宿主换掉——这也是为什么它们被抽成单独的
 * Port 并在组装层显式绑定，而不是藏在 DefaultRuntimeRunService 的字段里。
 * @returns 三个互不依赖的进程内状态所有者；每次调用都创建独立实例，彼此不共享状态。
 */
export function createRuntimeControlPlane(): RuntimeControlPlane {
  return {
    lifecycle: new DefaultRuntimeLifecycle(),
    threadExecution: new DefaultThreadExecutionCoordinator(),
    resumeReceipts: new MemoryResumeReceiptStore(),
  };
}
