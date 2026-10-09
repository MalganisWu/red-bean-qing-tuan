import type { ContentRef } from "../../../protocol/content-reference.js";
import { serializeInterrupt } from "../../../protocol/interrupt.js";
import type { JsonObject, JsonValue } from "../../../protocol/json.js";
import {
  serializeRawMessage,
  type RawMessage,
} from "../../../protocol/message.js";
import { cloneCheckpoint } from "../../checkpoint/codec/checkpoint-clone.js";
import { serializeCheckpoint } from "../../checkpoint/codec/checkpoint-codec.js";
import type {
  Checkpoint,
  CheckpointStatus,
} from "../../checkpoint/model/checkpoint.js";
import type { CheckpointRecord } from "../../checkpoint/store/port/checkpoint-store.js";
import type { RuntimeResult } from "./runtime-result.js";

/** Runtime 结果与 checkpoint 之间的纯映射；不执行模型、工具或持久化。 */
export function cloneRuntimeResult(result: RuntimeResult): RuntimeResult {
  return {
    status: result.status,
    output: result.output,
    messages: cloneRuntimeMessages(result.messages),
    ...(result.interrupt ? { interrupt: { ...result.interrupt } } : {}),
    tokensUsed: result.tokensUsed,
    finishReason: result.finishReason,
    checkpoint: cloneCheckpoint(result.checkpoint),
    revision: result.revision,
  };
}

export function emptyRuntimeCheckpoint(
  threadId: string,
  userId: string,
  status: CheckpointStatus,
  messages: readonly RawMessage[],
): Checkpoint {
  return {
    version: 1,
    threadId,
    userId,
    status,
    messages: cloneRuntimeMessages(messages),
    contentRefs: [],
    lastResumeInterrupt: "",
    tokensUsed: 0,
    finishReason: "",
  };
}

export function runtimeResultFromCheckpoint(
  checkpointInput: Checkpoint,
): RuntimeResult {
  const checkpoint = cloneCheckpoint(checkpointInput);
  return {
    status: checkpoint.status,
    output: lastAssistantOutput(checkpoint.messages),
    messages: cloneRuntimeMessages(checkpoint.messages),
    ...(checkpoint.interrupt ? { interrupt: { ...checkpoint.interrupt } } : {}),
    tokensUsed: checkpoint.tokensUsed,
    finishReason: checkpoint.finishReason,
    checkpoint,
    revision: 0n,
  };
}

export function runtimeResultFromRecord(
  record: CheckpointRecord,
): RuntimeResult {
  const result = runtimeResultFromCheckpoint(record.checkpoint);
  result.revision = record.revision;
  return result;
}

export function serializeRuntimeResult(result: RuntimeResult): JsonObject {
  const payload: Record<string, JsonValue> = {
    status: result.status,
    checkpoint: serializeCheckpoint(result.checkpoint),
  };
  if (result.output !== "") payload["output"] = result.output;
  if (result.messages.length > 0)
    payload["messages"] = result.messages.map(serializeRawMessage);
  if (result.interrupt)
    payload["interrupt"] = serializeInterrupt(result.interrupt);
  if (result.tokensUsed !== 0) payload["tokens_used"] = result.tokensUsed;
  if (result.finishReason !== "")
    payload["finish_reason"] = result.finishReason;
  if (result.revision !== 0n)
    payload["revision"] = revisionToJson(result.revision);
  return payload;
}

export function cloneRuntimeMessages(
  messages: readonly RawMessage[],
): RawMessage[] {
  return messages.map(cloneMessage);
}

export function cloneRuntimeContentRef(reference: ContentRef): ContentRef {
  return {
    ...reference,
    ...(reference.meta ? { meta: { ...reference.meta } } : {}),
  };
}

function cloneMessage(message: RawMessage): RawMessage {
  return {
    role: message.role,
    content: message.content,
    ...(message.toolCalls
      ? {
          toolCalls: message.toolCalls.map((call) => ({
            ...call,
            function: { ...call.function },
          })),
        }
      : {}),
    ...(message.toolCallId ? { toolCallId: message.toolCallId } : {}),
    ...(message.name ? { name: message.name } : {}),
  };
}

function revisionToJson(revision: bigint): number {
  const value = Number(revision);
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(
      "runtime result revision exceeds JSON safe integer range",
    );
  }
  return value;
}

function lastAssistantOutput(messages: readonly RawMessage[]): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role === "assistant" && message.content !== null)
      return message.content;
  }
  return "";
}
