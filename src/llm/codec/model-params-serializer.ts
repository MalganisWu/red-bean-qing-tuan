import type { JsonObject, JsonValue } from "../../protocol/json.js";
import type { ModelParams } from "../model/model.js";

/**
 * 将中性模型参数转换为稳定 JSON 字段。
 * 未设置的参数**不写进 JSON**（而不是写 `null`）：同一组参数序列化结果因此逐字节稳定，
 * 可以直接参与快照比对；消费方也能用「字段缺席」可靠地判断「调用方没指定」。
 */
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
