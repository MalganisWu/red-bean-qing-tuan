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

  public run(
    request: AgentRequest,
    signal: AbortSignal,
  ): Promise<RuntimeResult> {
    return this.#service.run(request, signal);
  }

  public resume(
    request: ResumeRequest,
    signal: AbortSignal,
  ): Promise<RuntimeResult> {
    return this.#service.resume(request, signal);
  }

  public close(signal: AbortSignal): Promise<void> {
    return this.#service.close(signal);
  }
}
