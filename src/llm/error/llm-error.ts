/** LLM Adapter 的稳定错误分类。 */
export const LLM_ERROR_KINDS = Object.freeze({
  TEMPORARY: "llm_temporary",
  PERMANENT: "llm_permanent",
} as const);

/** LLM 调用失败的稳定分类，用于决定是否允许重试。 */
export type LlmErrorKind =
  (typeof LLM_ERROR_KINDS)[keyof typeof LLM_ERROR_KINDS];

/**
 * LLM 调用失败的载体。`kind` 是**唯一**供重试策略分支的字段，文案不是判据。
 * 消息直接从 cause 复制一份，使得 `error.message` 在不追进 cause 链时也可读——
 * 日志系统通常只打最外层。
 */
export class LlmError extends Error {
  /**
   * 该错误的稳定分类，是重试策略**唯一**允许分支的字段；与 `message` 文案无关。
   * 只读：分类在构造时确定，之后不应被改写。
   */
  public readonly kind: LlmErrorKind;

  public constructor(kind: LlmErrorKind, cause: Error) {
    super(cause.message, { cause });
    this.name = "LlmError";
    this.kind = kind;
  }
}

/**
 * 保留早期 NewLLMTemporary/NewLLMPermanent 对空值的兼容分类语义。
 *
 * cause 为空时不构造、也不抛错，而是返回 undefined：调用方据此把「没有底层错误」
 * 与「有错误」区分开，无需在调用前自行判空。
 *
 * @param kind - 要赋予新错误的稳定分类，决定上层是否允许重试。
 * @param cause - 底层错误；为空表示无需包装，函数返回 undefined。
 * @returns 包装好的 LlmError；cause 为空时返回 undefined。
 */
export function classifyLlmError(
  kind: LlmErrorKind,
  cause: Error | null | undefined,
): LlmError | undefined {
  return cause ? new LlmError(kind, cause) : undefined;
}

/**
 * `kind` 省略时只判断「是不是 LlmError」，给出时额外比对分类。
 *
 * @param value - 待判定的任意值，非 LlmError 一律为 false。
 * @param kind - 可选的期望分类；省略即不比对分类，仅校验类型。
 * @returns 是否满足给定的分类约束，可直接用于类型收窄。
 */
export function isLlmError(
  value: unknown,
  kind?: LlmErrorKind,
): value is LlmError {
  if (!(value instanceof LlmError)) return false;
  return kind === undefined || value.kind === kind;
}
