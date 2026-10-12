import type { LlmRequest } from "../../model/model.js";
import type { JsonObject, JsonValue } from "../../../protocol/json.js";
import { serializeRawMessage } from "../../../protocol/message.js";
import type { ToolSchema } from "../../../protocol/tool-schema.js";

/**
 * 将 Runtime 中性请求映射为 OpenAI-compatible wire payload。
 *
 * 两条约定：
 * - **可选参数缺席即不发送**，而不是发 `null`。多数兼容实现把显式 `null` 当作「用默认值」，
 *   但并非全部——省掉字段是唯一在各方都安全的写法。
 * - 恒开 `stream_options.include_usage`：usage 只在流的最后一帧出现，
 *   不主动要就不会有，token 统计便无从落地。
 */
export function openAiRequestPayload(
  modelName: string,
  request: LlmRequest,
): JsonObject {
  const payload: Record<string, JsonValue> = {
    model: modelName,
    messages: request.messages.map(serializeRawMessage),
    stream: true,
    stream_options: { include_usage: true },
  };
  if (request.params.thinking !== undefined) {
    payload["thinking"] = {
      type: request.params.thinking ? "enabled" : "disabled",
    };
  }
  if (request.params.temperature !== undefined) {
    payload["temperature"] = request.params.temperature;
  }
  if (request.params.maxTokens !== undefined) {
    payload["max_tokens"] = request.params.maxTokens;
  }
  if (request.tools.length > 0) {
    payload["tools"] = request.tools.map(serializeToolSchema);
  }
  return payload;
}

function serializeToolSchema(schema: ToolSchema): JsonObject {
  return {
    type: schema.type,
    function: {
      name: schema.function.name,
      description: schema.function.description,
      parameters: schema.function.parameters,
    },
  };
}
