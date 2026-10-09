/** LLM Adapter 的稳定错误分类。 */
export const LLM_ERROR_KINDS = Object.freeze({
  TEMPORARY: "llm_temporary",
  PERMANENT: "llm_permanent",
} as const);

/** LLM 调用失败的稳定分类，用于决定是否允许重试。 */
export type LlmErrorKind =
  (typeof LLM_ERROR_KINDS)[keyof typeof LLM_ERROR_KINDS];

export class LlmError extends Error {
  public readonly kind: LlmErrorKind;

  public constructor(kind: LlmErrorKind, cause: Error) {
    super(cause.message, { cause });
    this.name = "LlmError";
    this.kind = kind;
  }
}

/** 保留早期 NewLLMTemporary/NewLLMPermanent 对空值的兼容分类语义。 */
export function classifyLlmError(
  kind: LlmErrorKind,
  cause: Error | null | undefined,
): LlmError | undefined {
  return cause ? new LlmError(kind, cause) : undefined;
}

export function isLlmError(
  value: unknown,
  kind?: LlmErrorKind,
): value is LlmError {
  if (!(value instanceof LlmError)) return false;
  return kind === undefined || value.kind === kind;
}
