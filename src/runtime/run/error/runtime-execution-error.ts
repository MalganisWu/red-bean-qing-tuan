import type { RuntimeResult } from "../result/runtime-result.js";
import {
  cloneRuntimeResult,
  emptyRuntimeCheckpoint,
  runtimeResultFromCheckpoint,
} from "../result/runtime-result-mapper.js";
import { CHECKPOINT_STATUSES } from "../../checkpoint/checkpoint-status.js";

/** 运行失败异常会携带可安全返回给调用方的结构化 Runtime 结果。 */
export class RuntimeExecutionError extends Error {
  /** 失败那一刻的结构化结果，已深拷贝，可安全交回调用方；status 通常是 failed 或 cancelled。 */
  public readonly result: RuntimeResult;

  public constructor(message: string, result: RuntimeResult, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "RuntimeExecutionError";
    this.result = cloneRuntimeResult(result);
  }
}

/**
 * 把任意抛出物统一成 Error；非 Error 一律 `String(...)`，不做结构探测。
 * @param value - 任意抛出物；只区分「是不是 Error」，不读取其自定义字段。
 * @returns 原样的 Error，或字符串化后包装出的新 Error。
 */
export function normalizeRuntimeError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

/**
 * 优先沿用 `signal.reason`：调用方通过 `abort(customReason)` 传入的原因不该被换成通用文案。
 * @param signal - 已中止的取消信号；只读取其 reason，不改变信号自身状态。
 * @returns 调用方给出的原因（若为 Error），否则是一个通用的 AbortError。
 */
export function runtimeAbortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new DOMException("operation aborted", "AbortError");
}

/**
 * 统一失败出口：构造 `RuntimeExecutionError` 并抛出。`never` 让调用点的后续代码在类型上不可达。
 * @param result - 失败那一刻的结构化结果，会被深拷贝后挂到异常上。
 * @param message - 面向人的失败原因，直接作为异常的 message。
 * @param cause - 根因；保留在 cause 链上，避免宿主日志断链。
 */
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
 * @param errors - 同一逻辑失败上的若干原因；空数组时退化为一个通用错误。
 * @returns 唯一一个原因本身，或聚合了全部原因（含各自 message）的 AggregateError。
 */
export function combineRuntimeErrors(errors: readonly Error[]): Error {
  if (errors.length === 1) return errors[0] ?? new Error("runtime 执行失败");
  return new AggregateError(
    errors,
    errors.map((error: Error): string => error.message).join("; "),
  );
}

/**
 * 构造一个「还没跑到任何一步就失败」的结果：状态 failed、无消息、revision 0。
 * @param threadId - 该结果指向的 thread；用于让调用方定位失败发生在哪个会话。
 * @param userId - 该结果声明的所有者；空串表示未声明身份。
 * @returns status 为 failed、revision 恒为 0n 的空结果，供失败出口携带。
 */
export function failedRuntimeResult(
  threadId: string,
  userId: string,
): RuntimeResult {
  return runtimeResultFromCheckpoint(
    emptyRuntimeCheckpoint(threadId, userId, CHECKPOINT_STATUSES.FAILED, []),
  );
}
