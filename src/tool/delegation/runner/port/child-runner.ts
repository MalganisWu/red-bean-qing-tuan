import type { Interrupt } from "../../../../protocol/interrupt.js";
import type {
  RunIdentity,
  RuntimeEventSink,
} from "../../../../protocol/run-identity.js";

/**
 * 子运行可返回的稳定状态。
 * 只有 `SUSPENDED` 是「可继续」的——委派工具会把它连同执行 ID 交回给父 Agent；
 * 其余四种都是终局，区别仅在于父 Agent 看到的原因不同。
 */
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
  /** 空串表示新建执行；非空表示续跑该执行，且返回的 executionId 必须与之一致。 */
  readonly executionId: string;
  /** 父运行中触发本次委派的工具调用 ID，用于把子执行挂回父链路。 */
  readonly parentCallId: string;
  readonly instruction: string;
  readonly context: string;
  readonly expectedFormat: string;
  /** 仅在恢复挂起的子运行时出现。 */
  readonly resume?: ChildResume | undefined;
  /** 宿主用它把子运行的中间事件转发给自己的展示层；SDK 不解释其内容。 */
  readonly eventSink?: RuntimeEventSink | undefined;
}

/**
 * 宿主 ChildRunner 返回的中性结果；产品 Session 和展示 DTO 不得混入。
 *
 * 字段按状态分组：`output` 只对 `completed` 有意义，`partialOutput` 在失败与挂起时都可能出现，
 * `interrupt` 只在 `suspended` 时必需。预留可选而非联合类型，是为了让宿主的实现
 * 不必在类型上穷举所有组合。
 */
export interface ChildRunResult {
  readonly status: ChildRunStatus;
  readonly executionId?: string | undefined;
  readonly output?: string | undefined;
  readonly partialOutput?: string | undefined;
  readonly error?: string | undefined;
  readonly interrupt?: Interrupt | undefined;
}

/**
 * 子 Agent 执行 Port；没有 SDK 默认实现，持久化、权限和展示均由宿主负责。
 *
 * 子运行**不是** Runtime 的内部能力：Runtime 只负责把一个委派调用翻译成这个请求并解释结果，
 * 「子 Agent 用什么模型、能不能访问网络、执行记录存在哪」全部留在宿主。
 * 实现应当在失败时抛 `ChildRunError` 并带上部分结果，而不是返回一个丢了上下文的空失败。
 */
export interface ChildRunner {
  runChild(
    request: ChildRunRequest,
    signal: AbortSignal,
  ): Promise<ChildRunResult>;
}
