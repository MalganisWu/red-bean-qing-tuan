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
  /** 组装完成的能力图（模型、分发器、Store、事件出口等），构造期固定。 */
  readonly configuration: RuntimeConfiguration;
  /** 静态插件注册表；构造期已封闭，服务仅用它关闭插件。 */
  readonly plugins: PluginRegistry;
  /** 已封闭的 run 中间件快照；run 与 resume 共用。 */
  readonly runMiddleware: readonly RunMiddleware[];
  /** 运行记账与关闭时序的所有者。 */
  readonly lifecycle: RuntimeLifecycle;
  /** 逐 thread 串行化协调器；同 thread 的并发调用在此排队。 */
  readonly threadExecution: ThreadExecutionCoordinator;
  /** 无 Store 模式的幂等收据存储。 */
  readonly resumeReceipts: ResumeReceiptStore;
  /** 底层执行器，负责 ReAct 循环与 checkpoint 保存。 */
  readonly execution: AgentExecution;
}
