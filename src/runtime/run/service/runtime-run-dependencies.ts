import type {
  PluginRegistry,
  RunMiddleware,
} from "../../../runtime/plugin/runtime-plugin.js";
import type { AgentExecution } from "../../../pipeline/execution/port/agent-execution.js";
import type { RuntimeLifecycle } from "../../lifecycle/port/runtime-lifecycle.js";
import type { ResumeReceiptStore } from "../../resume-receipt/port/resume-receipt-store.js";
import type { ThreadExecutionCoordinator } from "../../thread-execution/port/thread-execution-coordinator.js";
import type { RuntimeConfiguration } from "../model/runtime-configuration.js";

/** DefaultRuntimeRunService 的显式依赖图，仅由 composition root 构造。 */
export interface RuntimeRunDependencies {
  readonly configuration: RuntimeConfiguration;
  readonly plugins: PluginRegistry;
  readonly runMiddleware: readonly RunMiddleware[];
  readonly lifecycle: RuntimeLifecycle;
  readonly threadExecution: ThreadExecutionCoordinator;
  readonly resumeReceipts: ResumeReceiptStore;
  readonly execution: AgentExecution;
}
