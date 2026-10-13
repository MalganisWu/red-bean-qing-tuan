import type {
  AgentRequest,
  ResumeRequest,
} from "../../../runtime/run/model/runtime-request.js";
import type { RuntimeResult } from "../result/runtime-result.js";

/** AgentRuntime 门面委托的完整运行用例；SDK 默认实现为由 runtime-composition.ts 组装的 DefaultRuntimeRunService。 */
export interface RuntimeRunService {
  /**
   * 执行一次新的 Agent 运行直到终态。
   *
   * @param request - 本次运行的输入；state/history 与 Store 模式互斥
   * @param signal - 调用方的取消信号；Runtime 只消费不拥有它
   * @returns 终态结果；失败可能以结果形式返回，或在携带部分结果时抛 RuntimeExecutionError
   */
  run(request: AgentRequest, signal: AbortSignal): Promise<RuntimeResult>;
  /**
   * 恢复一次中断的运行：回答 interrupt 后继续执行。
   *
   * @param request - 恢复输入；interruptId 必填，无 Store 模式还需 requestId 作幂等键
   * @param signal - 调用方的取消信号；取消同样收敛为结果或异常
   * @returns 恢复后的终态结果；命中回执时直接回放，不会二次执行工具
   */
  resume(request: ResumeRequest, signal: AbortSignal): Promise<RuntimeResult>;
  /**
   * 释放运行服务持有的资源。
   *
   * @param signal - 关闭的取消信号；只约束等待，不取消已经登记的清理工作
   */
  close(signal: AbortSignal): Promise<void>;
}
