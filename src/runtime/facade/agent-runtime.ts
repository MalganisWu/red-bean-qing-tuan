import type {
  AgentRequest,
  ResumeRequest,
} from "../../runtime/run/model/runtime-request.js";
import type { RuntimeResult } from "../run/result/runtime-result.js";
import type { AgentRuntimeOptions } from "../run/model/runtime-run-options.js";
import type { RuntimeRunService } from "../run/port/runtime-run-service.js";
import { createRuntimeRunService } from "../runtime-composition.js";

export { EVENT_SINK_ERROR_POLICIES } from "../run/event-sink-error-policy.js";
export { RuntimeExecutionError } from "../run/error/runtime-execution-error.js";
export { serializeRuntimeResult } from "../run/result/runtime-result-mapper.js";
export type {
  AgentRuntimeOptions,
  EventSink,
  EventSinkErrorPolicy,
  ToolPolicy,
} from "../run/model/runtime-run-options.js";
export type {
  AgentRequest,
  ResumeRequest,
} from "../run/model/runtime-request.js";
export type { RuntimeResult } from "../run/result/runtime-result.js";

/**
 * Runtime 的稳定公开门面。
 * 默认实现的完整组装与运行编排位于 DefaultRuntimeRunService。
 *
 * 本类只做三件事：构造期组装一次、把 run/resume/close 透传下去。
 * 它不是运行期 Service Locator——依赖在构造函数里一次装配完毕，之后不再变化。
 * 本文件同时是这些类型的公开导出点，改导出清单等于改公共 API（由 api surface 快照守住）。
 */
export class AgentRuntime {
  readonly #service: RuntimeRunService;

  public constructor(options: AgentRuntimeOptions) {
    this.#service = createRuntimeRunService(options);
  }

  /**
   * 执行一次新的 Agent 运行直到终态。
   * @param request - 本次运行的输入；state/history 与 Store 模式互斥，具体约束由请求校验器判定。
   * @param signal - 调用方的取消信号；Runtime 只消费不拥有它，取消会收敛为 cancelled 结果或携带部分结果的异常。
   * @returns 终态 RuntimeResult；失败以结果形式返回，或在携带部分结果时抛 RuntimeExecutionError。
   */
  public run(
    request: AgentRequest,
    signal: AbortSignal,
  ): Promise<RuntimeResult> {
    return this.#service.run(request, signal);
  }

  /**
   * 恢复一次中断的运行：回答 interrupt 后继续执行。
   * @param request - 恢复输入；interruptId 必填，无 Store 模式还需 requestId 作幂等键。
   * @param signal - 调用方的取消信号；取消同样收敛为结果或异常，不向外传播原始抛出物。
   * @returns 恢复后的终态 RuntimeResult；命中回执时直接回放，不会二次执行工具。
   */
  public resume(
    request: ResumeRequest,
    signal: AbortSignal,
  ): Promise<RuntimeResult> {
    return this.#service.resume(request, signal);
  }

  /**
   * 关闭门面：按 lifecycle 的顺序释放插件与其他资源。
   * @param signal - 关闭的取消信号；只约束等待，不取消已经登记的清理工作。
   */
  public close(signal: AbortSignal): Promise<void> {
    return this.#service.close(signal);
  }
}
