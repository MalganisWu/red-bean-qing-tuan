/**
 * Runtime 公开错误码与可编程错误类型。
 *
 * 这些字符串是**宿主分支判断的唯一依据**，属于公共 API：新增码是兼容的，
 * 改名或删除则是破坏性变更（由 api surface 快照与声明基线守住）。
 * 配套的 `RUNTIME_ERROR_MESSAGES` 也刻意固定——文案不作为判断依据，
 * 但保持稳定才能让日志与告警的聚合规则不因版本升级而失效。
 */
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

/**
 * 错误码到稳定文案的映射，供 RuntimeError 构造时套用。
 *
 * 文案不参与任何分支判断，但刻意固定不变：日志与告警常按文案做聚合，
 * 文案随版本漂移会让历史聚合规则失效。因此分支一律看 `code`，文案只看可读性。
 */
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
  /** 构造时传入的错误码，也是宿主分支判断的依据；与 message 文案解耦，可安全比较。 */
  public readonly code: RuntimeErrorCode;

  public constructor(code: RuntimeErrorCode, options?: ErrorOptions) {
    super(RUNTIME_ERROR_MESSAGES[code], options);
    this.name = "RuntimeError";
    this.code = code;
  }
}

/**
 * `code` 省略时只判断「是不是 RuntimeError」，给出时额外比对错误码。
 *
 * @param value - 任意待判定值，按 `instanceof` 判定，不做结构探测，因此跨 realm 或包装过的错误不会被误判。
 * @param code - 可选的期望错误码；给出时必须与实例的 code 全等才算命中，省略则退化为纯类型判定。
 * @returns 命中类型、且（未指定 code 或 code 相符）时为 true。
 */
export function isRuntimeError(
  value: unknown,
  code?: RuntimeErrorCode,
): value is RuntimeError {
  if (!(value instanceof RuntimeError)) return false;
  return code === undefined || value.code === code;
}
