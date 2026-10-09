import type { RuntimeLifecycle } from "./lifecycle/port/runtime-lifecycle.js";
import { DefaultRuntimeLifecycle } from "./lifecycle/service/default-runtime-lifecycle.js";
import type { ResumeReceiptStore } from "./resume-receipt/port/resume-receipt-store.js";
import { MemoryResumeReceiptStore } from "./resume-receipt/service/memory-resume-receipt-store.js";
import type { ThreadExecutionCoordinator } from "./thread-execution/port/thread-execution-coordinator.js";
import { DefaultThreadExecutionCoordinator } from "./thread-execution/service/default-thread-execution-coordinator.js";

/** Runtime 内部三个独立状态所有者的组装结果，不向业务层暴露可变容器。 */
export interface RuntimeControlPlane {
  readonly lifecycle: RuntimeLifecycle;
  readonly threadExecution: ThreadExecutionCoordinator;
  readonly resumeReceipts: ResumeReceiptStore;
}

/** 创建并明确绑定 Runtime 内部三个状态所有者。 */
export function createRuntimeControlPlane(): RuntimeControlPlane {
  return {
    lifecycle: new DefaultRuntimeLifecycle(),
    threadExecution: new DefaultThreadExecutionCoordinator(),
    resumeReceipts: new MemoryResumeReceiptStore(),
  };
}
