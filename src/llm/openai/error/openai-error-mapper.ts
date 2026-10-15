import { LLM_ERROR_KINDS, LlmError } from "../../error/llm-error.js";

// 取消原因取自协议层的中性 helper。
// 本模块历史上自己实现过一份，现已统一到 `protocol/abort-signal.ts`，避免同一个语义散落多份。
export { abortError } from "../../../protocol/abort-signal.js";

/**
 * 把任意抛出物统一成 Error；非 Error 一律 `String(...)`，不做结构探测。
 *
 * @param value - 任意被抛出的值，可能是 Error 也可能不是。
 * @returns 保证是 Error 实例；非 Error 输入被包装成承载其字符串形式的 Error。
 */
export function normalizeError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

/**
 * 协议层错误一律是**永久**的：provider 回了一个解析不了或形状不对的响应，
 * 原样重试只会得到同样的结果，重试反而会把一次配置错误放大成持续的无效请求。
 *
 * @param message - 面向宿主的错误描述，会被复制到最外层 error.message。
 * @param cause - 可选的底层原因；提供时挂进 cause 链供排查。
 * @returns 分类为 PERMANENT 的 LlmError。
 */
export function openAiProtocolError(
  message: string,
  cause?: unknown,
): LlmError {
  const error = new Error(message, cause === undefined ? undefined : { cause });
  return new LlmError(LLM_ERROR_KINDS.PERMANENT, error);
}

/**
 * 将 HTTP 状态映射为稳定的临时或永久 LLM 错误。
 *
 * 这个二分类就是整个 SDK 的重试策略分界线：`429` 与 `5xx` 是**临时**（限流、上游抖动，
 * 退避后值得再试），其余 4xx 是**永久**（鉴权、参数、配额耗尽——重试不会变好）。
 * 改这里的映射等于改所有宿主的重试行为。
 *
 * @param status - HTTP 响应状态码，429 与 5xx 之外一律归为永久错误。
 * @param responseBody - 已读取的响应体文本，原样拼进错误消息便于诊断。
 * @returns 依状态码分类好的 LlmError。
 */
export function openAiHttpError(
  status: number,
  responseBody: string,
): LlmError {
  const kind =
    status === 429 || status >= 500
      ? LLM_ERROR_KINDS.TEMPORARY
      : LLM_ERROR_KINDS.PERMANENT;
  return new LlmError(
    kind,
    new Error(`OpenAI 兼容接口返回错误 ${status}：${responseBody}`),
  );
}
