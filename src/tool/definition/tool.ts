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
/** 工具执行的中性结果；可附带控制信号或需要 checkpoint 保留的内容引用。 */
export interface ToolResult {
  readonly content: string;
  readonly signal?: Signal | undefined;
  readonly preserve?: ContentRef | undefined;
}

/** Runtime 可调用工具的中性定义。 */
export interface Tool {
  readonly name: string;
  readonly schema: ToolSchema;
  execute(
    params: JsonValue,
    context: ToolCallContext,
    signal: AbortSignal,
  ): Promise<ToolResult>;
}
