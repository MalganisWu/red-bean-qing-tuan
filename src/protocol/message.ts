import type { JsonObject, JsonValue } from "./json.js";
import type { ToolCall } from "./tool-call.js";

/** Runtime、LLM 与 Checkpoint 共用的中性消息，不包含产品展示字段。 */
export interface RawMessage {
  readonly role: string;
  readonly content: string | null;
  readonly toolCalls?: readonly ToolCall[] | undefined;
  readonly toolCallId?: string | undefined;
  readonly name?: string | undefined;
}

function serializeToolCall(call: ToolCall): JsonObject {
  const payload: Record<string, JsonValue> = {
    id: call.id,
    type: call.type,
    function: {
      name: call.function.name,
      arguments: call.function.arguments,
    },
  };
  if (call.index !== undefined && call.index !== 0)
    payload["index"] = call.index;
  return payload;
}

/**
 * 将中性消息序列化为稳定的 OpenAI-compatible JSON 结构。
 *
 * @param message - 待序列化的中性消息；`toolCalls` 为空数组、`toolCallId`/`name` 为空串时
 *   一律视为未设置，与本字段缺失等价。
 * @returns 键序固定为 `role`、`content` 再按需追加可选字段的 JSON 对象，未设置字段不写出，
 *   可参与快照比对。
 */
export function serializeRawMessage(message: RawMessage): JsonObject {
  const payload: Record<string, JsonValue> = {
    role: message.role,
    content: message.content,
  };
  if (message.toolCalls && message.toolCalls.length > 0) {
    payload["tool_calls"] = message.toolCalls.map(serializeToolCall);
  }
  if (message.toolCallId) payload["tool_call_id"] = message.toolCallId;
  if (message.name) payload["name"] = message.name;
  return payload;
}
