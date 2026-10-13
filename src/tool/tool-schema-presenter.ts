import type { LlmToolSchema, ToolSchema } from "../protocol/tool-schema.js";

/**
 * 工具定义发给 LLM 前移除仅供 Runtime 使用的 metadata。
 *
 * @param schema - Runtime 侧完整的工具定义；其中的 Runtime 元数据不参与投影。
 * @returns 只含 `type` 与 `function` 的 wire 形状，可直接放进请求体。
 */
export function toLlmToolSchema(schema: ToolSchema): LlmToolSchema {
  return {
    type: schema.type,
    function: schema.function,
  };
}
