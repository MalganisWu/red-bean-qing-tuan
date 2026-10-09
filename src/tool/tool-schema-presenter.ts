import type { LlmToolSchema, ToolSchema } from "../protocol/tool-schema.js";

/** 工具定义发给 LLM 前移除仅供 Runtime 使用的 metadata。 */
export function toLlmToolSchema(schema: ToolSchema): LlmToolSchema {
  return {
    type: schema.type,
    function: schema.function,
  };
}
