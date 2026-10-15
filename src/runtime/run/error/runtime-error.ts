/**
 * Runtime 公开错误码与可编程错误类型。
 *
 * 这些字符串是**宿主分支判断的唯一依据**，属于公共 API：新增码是兼容的，
 * 改名或删除则是破坏性变更（由 api surface 快照与声明基线守住）。
 * 配套的 `RUNTIME_ERROR_MESSAGES` 只求可读，**不承担判断职责**：分支、告警分类与聚合一律看
 * `code` 这个稳定字段，不要依赖 `message` 的全文或子串。
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
 * 错误码到说明文案的映射，供 RuntimeError 构造时套用。
 *
 * 文案只供人阅读：它会随版本改进，也可能本地化。**机器判断一律看 `code`** ——
 * 把整句文本当成聚合依据，会让文案再也无法改动或本地化。技术标识（`sessionId` 一类字段名、
 * 协议名、具体 ID）保留原文。
 */
const RUNTIME_ERROR_MESSAGES: Readonly<Record<RuntimeErrorCode, string>> =
  Object.freeze({
    checkpoint_not_found: "找不到 checkpoint",
    checkpoint_not_suspended: "checkpoint 不处于挂起状态",
    interrupt_mismatch: "interrupt ID 与挂起的 checkpoint 不符",
    interrupt_already_consumed: "interrupt 已经被消费",
    resume_in_progress: "该 resume 已经在进行中",
    thread_busy: "该 thread 有正在进行的 resume",
    checkpoint_revision_conflict: "checkpoint revision 冲突",
    stale_fencing_token: "fencing token 已过期",
    checkpoint_fencing_unsupported: "该 checkpoint 不支持 fencing",
    idempotency_conflict: "幂等键与已存在的请求冲突",
    replayed_resume_failure: "重放 resume 以错误状态结束",
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
