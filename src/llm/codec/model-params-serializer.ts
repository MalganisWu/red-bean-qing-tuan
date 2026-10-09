import type { JsonObject, JsonValue } from "../../protocol/json.js";
import type { ModelParams } from "../model/model.js";

/** 将中性模型参数转换为稳定 JSON 字段。 */
export function serializeModelParams(params: ModelParams): JsonObject {
  const payload: Record<string, JsonValue> = {};
  if (params.temperature !== undefined)
    payload["temperature"] = params.temperature;
  if (params.maxTokens !== undefined) payload["max_tokens"] = params.maxTokens;
  if (params.contextWindow !== undefined)
    payload["context_window"] = params.contextWindow;
  if (params.thinking !== undefined) payload["thinking"] = params.thinking;
  return payload;
}
