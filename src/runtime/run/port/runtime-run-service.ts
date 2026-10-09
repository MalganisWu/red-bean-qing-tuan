import type {
  AgentRequest,
  ResumeRequest,
} from "../../../runtime/run/model/runtime-request.js";
import type { RuntimeResult } from "../result/runtime-result.js";

/** AgentRuntime 门面委托的完整运行用例；SDK 默认实现为由 runtime-composition.ts 组装的 DefaultRuntimeRunService。 */
export interface RuntimeRunService {
  run(request: AgentRequest, signal: AbortSignal): Promise<RuntimeResult>;
  resume(request: ResumeRequest, signal: AbortSignal): Promise<RuntimeResult>;
  close(signal: AbortSignal): Promise<void>;
}
