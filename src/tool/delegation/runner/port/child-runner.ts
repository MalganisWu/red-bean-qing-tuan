import type { Interrupt } from "../../../../protocol/interrupt.js";
import type {
  RunIdentity,
  RuntimeEventSink,
} from "../../../../protocol/run-identity.js";

export const CHILD_RUN_STATUSES = Object.freeze({
  COMPLETED: "completed",
  SUSPENDED: "suspended",
  FAILED: "failed",
  CANCELLED: "cancelled",
  EXHAUSTED: "exhausted",
} as const);

/** 子 Agent 运行可返回给委派工具的稳定状态。 */
export type ChildRunStatus =
  (typeof CHILD_RUN_STATUSES)[keyof typeof CHILD_RUN_STATUSES];

/** 恢复已挂起子运行时由宿主验证并转交的回答。 */
export interface ChildResume {
  readonly interruptId: string;
  readonly response: string;
}

/** 委派工具交给宿主 ChildRunner 的中性执行请求。 */
export interface ChildRunRequest extends RunIdentity {
  readonly agentId: string;
  readonly executionId: string;
  readonly parentCallId: string;
  readonly instruction: string;
  readonly context: string;
  readonly expectedFormat: string;
  readonly resume?: ChildResume | undefined;
  readonly eventSink?: RuntimeEventSink | undefined;
}

/** 宿主 ChildRunner 返回的中性结果；产品 Session 和展示 DTO 不得混入。 */
export interface ChildRunResult {
  readonly status: ChildRunStatus;
  readonly executionId?: string | undefined;
  readonly output?: string | undefined;
  readonly partialOutput?: string | undefined;
  readonly error?: string | undefined;
  readonly interrupt?: Interrupt | undefined;
}

/** 子 Agent 执行 Port；没有 SDK 默认实现，持久化、权限和展示均由宿主负责。 */
export interface ChildRunner {
  runChild(
    request: ChildRunRequest,
    signal: AbortSignal,
  ): Promise<ChildRunResult>;
}
