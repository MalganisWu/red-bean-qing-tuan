/** Runtime 公开错误码与可编程错误类型。 */
export const RUNTIME_ERROR_CODES = Object.freeze({
  CHECKPOINT_NOT_FOUND: "checkpoint_not_found",
  CHECKPOINT_NOT_SUSPENDED: "checkpoint_not_suspended",
  INTERRUPT_MISMATCH: "interrupt_mismatch",
  INTERRUPT_ALREADY_CONSUMED: "interrupt_already_consumed",
  RESUME_IN_PROGRESS: "resume_in_progress",
  THREAD_BUSY: "thread_busy",
  REVISION_CONFLICT: "checkpoint_revision_conflict",
  STALE_FENCE: "stale_fencing_token",
  FENCING_UNSUPPORTED: "checkpoint_fencing_unsupported",
  IDEMPOTENCY_CONFLICT: "idempotency_conflict",
  REPLAYED_FAILURE: "replayed_resume_failure",
} as const);

/** 宿主可以稳定分支处理的 Runtime 错误码联合。 */
export type RuntimeErrorCode =
  (typeof RUNTIME_ERROR_CODES)[keyof typeof RUNTIME_ERROR_CODES];

const RUNTIME_ERROR_MESSAGES: Readonly<Record<RuntimeErrorCode, string>> =
  Object.freeze({
    checkpoint_not_found: "checkpoint not found",
    checkpoint_not_suspended: "checkpoint is not suspended",
    interrupt_mismatch: "interrupt ID does not match suspended checkpoint",
    interrupt_already_consumed: "interrupt has already been consumed",
    resume_in_progress: "resume is already in progress",
    thread_busy: "thread has an in-progress resume",
    checkpoint_revision_conflict: "checkpoint revision conflict",
    stale_fencing_token: "stale fencing token",
    checkpoint_fencing_unsupported: "checkpoint fencing is unsupported",
    idempotency_conflict: "idempotency key conflicts with an existing request",
    replayed_resume_failure: "replayed resume completed with an error status",
  });

/** 可稳定编程识别的 Runtime 错误，替代早期实现中的 sentinel error。 */
export class RuntimeError extends Error {
  public readonly code: RuntimeErrorCode;

  public constructor(code: RuntimeErrorCode, options?: ErrorOptions) {
    super(RUNTIME_ERROR_MESSAGES[code], options);
    this.name = "RuntimeError";
    this.code = code;
  }
}

export function isRuntimeError(
  value: unknown,
  code?: RuntimeErrorCode,
): value is RuntimeError {
  if (!(value instanceof RuntimeError)) return false;
  return code === undefined || value.code === code;
}
