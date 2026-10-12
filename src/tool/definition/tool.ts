import type { ContentRef } from "../../protocol/content-reference.js";
import type { Signal } from "../../protocol/interrupt.js";
import type { JsonValue } from "../../protocol/json.js";
import type { ToolCallContext } from "../../protocol/run-identity.js";
import type { ToolSchema } from "../../protocol/tool-schema.js";

export type { ToolCallContext } from "../../protocol/run-identity.js";
export type { ToolCall, ToolCallFunction } from "../../protocol/tool-call.js";
export type {
  LlmToolSchema,
  ToolFunction,
  ToolSchema,
} from "../../protocol/tool-schema.js";
/**
 * 工具执行的中性结果；可附带控制信号或需要 checkpoint 保留的内容引用。
 *
 * 三个字段承担三种语义，通常只用其一：
 * - `content`：给模型看的正文，永远存在（哪怕是空串）。
 * - `signal`：控制信号。设置 `interrupt` 表示「这个工具要求挂起」，此时本次不会产生正文结果。
 * - `preserve`：大块内容的引用。工具可以不把全文塞进 `content`，而是登记一份引用，
 *   由宿主决定何时取回——压缩后的内容恢复靠它。
 */
export interface ToolResult {
  readonly content: string;
  readonly signal?: Signal | undefined;
  readonly preserve?: ContentRef | undefined;
}

/**
 * Runtime 可调用工具的中性定义。
 * `name` 是模型看到的调用名，必须与 `schema.function.name` 一致——
 * 不一致会让「模型请求的工具」与「分发时查找的工具」指向两个不同的东西。
 */
export interface Tool {
  readonly name: string;
  readonly schema: ToolSchema;
  execute(
    params: JsonValue,
    context: ToolCallContext,
    signal: AbortSignal,
  ): Promise<ToolResult>;
}
