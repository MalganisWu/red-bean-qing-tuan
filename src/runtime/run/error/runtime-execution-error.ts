import type { RuntimeResult } from "../result/runtime-result.js";
import {
  cloneRuntimeResult,
  emptyRuntimeCheckpoint,
  runtimeResultFromCheckpoint,
} from "../result/runtime-result-mapper.js";
import { CHECKPOINT_STATUSES } from "../../checkpoint/checkpoint-status.js";

/** 运行失败异常会携带可安全返回给调用方的结构化 Runtime 结果。 */
export class RuntimeExecutionError extends Error {
  public readonly result: RuntimeResult;

  public constructor(message: string, result: RuntimeResult, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "RuntimeExecutionError";
    this.result = cloneRuntimeResult(result);
  }
}

/** 把任意抛出物统一成 Error；非 Error 一律 `String(...)`，不做结构探测。 */
export function normalizeRuntimeError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

/** 优先沿用 `signal.reason`：调用方通过 `abort(customReason)` 传入的原因不该被换成通用文案。 */
export function runtimeAbortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new DOMException("operation aborted", "AbortError");
}

/** 统一失败出口：构造 `RuntimeExecutionError` 并抛出。`never` 让调用点的后续代码在类型上不可达。 */
export function failRuntimeExecution(
  result: RuntimeResult,
  message: string,
  cause: unknown,
): never {
  throw new RuntimeExecutionError(message, result, cause);
}

/**
 * 合并同一逻辑失败上的多个原因。
 * 单个错误直接原样返回（不包一层 AggregateError）——绝大多数情况只有一个原因，
 * 多包一层只会让调用方的 `instanceof` 判断多一次无谓的分支。
 */
export function combineRuntimeErrors(errors: readonly Error[]): Error {
  if (errors.length === 1) return errors[0] ?? new Error("runtime failed");
  return new AggregateError(
    errors,
    errors.map((error: Error): string => error.message).join("; "),
  );
}

/** 构造一个「还没跑到任何一步就失败」的结果：状态 failed、无消息、revision 0。 */
export function failedRuntimeResult(
  threadId: string,
  userId: string,
): RuntimeResult {
  return runtimeResultFromCheckpoint(
    emptyRuntimeCheckpoint(threadId, userId, CHECKPOINT_STATUSES.FAILED, []),
  );
}
