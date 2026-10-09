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

export function normalizeRuntimeError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

export function runtimeAbortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new DOMException("operation aborted", "AbortError");
}

export function failRuntimeExecution(
  result: RuntimeResult,
  message: string,
  cause: unknown,
): never {
  throw new RuntimeExecutionError(message, result, cause);
}

export function combineRuntimeErrors(errors: readonly Error[]): Error {
  if (errors.length === 1) return errors[0] ?? new Error("runtime failed");
  return new AggregateError(
    errors,
    errors.map((error: Error): string => error.message).join("; "),
  );
}

export function failedRuntimeResult(
  threadId: string,
  userId: string,
): RuntimeResult {
  return runtimeResultFromCheckpoint(
    emptyRuntimeCheckpoint(threadId, userId, CHECKPOINT_STATUSES.FAILED, []),
  );
}
