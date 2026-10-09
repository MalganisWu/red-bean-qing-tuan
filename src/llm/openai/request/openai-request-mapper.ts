import type { LlmRequest } from "../../model/model.js";
import type { JsonObject, JsonValue } from "../../../protocol/json.js";
import { serializeRawMessage } from "../../../protocol/message.js";
import type { ToolSchema } from "../../../protocol/tool-schema.js";

/** 将 Runtime 中性请求映射为 OpenAI-compatible wire payload。 */
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
