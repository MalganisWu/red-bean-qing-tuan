import type {
  PluginRegistry,
  RunMiddleware,
} from "../../../runtime/plugin/runtime-plugin.js";
import type { AgentExecution } from "../../../pipeline/execution/port/agent-execution.js";
import type { RuntimeLifecycle } from "../../lifecycle/port/runtime-lifecycle.js";
import type { ResumeReceiptStore } from "../../resume-receipt/port/resume-receipt-store.js";
import type { ThreadExecutionCoordinator } from "../../thread-execution/port/thread-execution-coordinator.js";
import type { RuntimeConfiguration } from "../model/runtime-configuration.js";

/**
 * DefaultRuntimeRunService 的显式依赖图，仅由 composition root 构造。
 *
 * 单列一个接口而不是让服务直接读构造参数，是为了让「这个服务到底依赖哪些东西」
 * 成为类型上可见的事实；测试也据此注入替身，不必启动整条组装链。
 */
export interface RuntimeRunDependencies {
  readonly configuration: RuntimeConfiguration;
  readonly plugins: PluginRegistry;
  readonly runMiddleware: readonly RunMiddleware[];
  readonly lifecycle: RuntimeLifecycle;
  readonly threadExecution: ThreadExecutionCoordinator;
  readonly resumeReceipts: ResumeReceiptStore;
  readonly execution: AgentExecution;
}
