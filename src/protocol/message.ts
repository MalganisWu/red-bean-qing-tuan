import type { JsonObject, JsonValue } from "./json.js";
import type { ToolCall } from "./tool-call.js";

/** Runtime、LLM 与 Checkpoint 共用的中性消息，不包含产品展示字段。 */
export interface RawMessage {
  /** 消息角色，取值沿用 OpenAI 约定（`system`、`user`、`assistant`、`tool`）；保持字符串不枚举，便于适配新角色。 */
  readonly role: string;
  /** 文本内容；工具调用消息可为 `null`，与 OpenAI wire 上的 `null` 一致。 */
  readonly content: string | null;
  /** 助手消息携带的工具调用；空数组与未设置等价，序列化时不写出。 */
  readonly toolCalls?: readonly ToolCall[] | undefined;
  /** 工具结果消息回指的工具调用标识；空串与未设置等价。 */
  readonly toolCallId?: string | undefined;
  /** 可选的消息名（如函数名）；空串与未设置等价。 */
  readonly name?: string | undefined;
}

/**
 * 将中性工具调用序列化为 OpenAI-compatible wire 结构。
 *
 * 流式分片里的 `index` 只在非零时写出，与整包响应的缺省分片保持一致，避免快照出现噪声差异。
 *
 * @param call - 待序列化的工具调用；只读取 `id`、`type`、`function` 与可选 `index`。
 * @returns 键序固定为 `id`、`type`、`function` 再按需追加 `index` 的 JSON 对象。
 */
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
