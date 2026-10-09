import type { ContentRef } from "../../../protocol/content-reference.js";
import {
  toJsonValue,
  type JsonObject,
  type JsonValue,
} from "../../../protocol/json.js";
import {
  serializeRawMessage,
  type RawMessage,
} from "../../../protocol/message.js";
import { serializeContentRef } from "../../../protocol/content-reference.js";
import { serializeInterrupt } from "../../../protocol/interrupt.js";
import {
  type Checkpoint,
  type CheckpointStatus,
  type ResumeClaim,
} from "../model/checkpoint.js";
import { CHECKPOINT_STATUSES } from "../checkpoint-status.js";
import type { CheckpointRecord } from "../store/port/checkpoint-store.js";

function revisionToJson(revision: bigint): number {
  const value = Number(revision);
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError("checkpoint revision exceeds JSON safe integer range");
  }
  return value;
}

/** 将 Runtime Checkpoint 写成稳定、宿主中立的 JSON 结构。 */
export function serializeCheckpoint(checkpoint: Checkpoint): JsonObject {
  const payload: Record<string, JsonValue> = {
    version: checkpoint.version,
    thread_id: checkpoint.threadId,
    status: checkpoint.status,
    messages: checkpoint.messages.map(serializeRawMessage),
  };
  if (checkpoint.userId !== "") payload["user_id"] = checkpoint.userId;
  if (checkpoint.contentRefs.length > 0)
    payload["content_refs"] = checkpoint.contentRefs.map(serializeContentRef);
  if (checkpoint.interrupt)
    payload["interrupt"] = serializeInterrupt(checkpoint.interrupt);
  if (checkpoint.resumeClaim) {
    payload["resume_claim"] = {
      interrupt_id: checkpoint.resumeClaim.interruptId,
      ...(checkpoint.resumeClaim.requestId !== ""
        ? { request_id: checkpoint.resumeClaim.requestId }
        : {}),
      response: checkpoint.resumeClaim.response,
      claimed_at: checkpoint.resumeClaim.claimedAt,
    };
  }
  if (checkpoint.lastResumeInterrupt !== "")
    payload["last_resume_interrupt"] = checkpoint.lastResumeInterrupt;
  if (checkpoint.tokensUsed !== 0)
    payload["tokens_used"] = checkpoint.tokensUsed;
  if (checkpoint.finishReason !== "")
    payload["finish_reason"] = checkpoint.finishReason;
  return payload;
}

export function serializeCheckpointRecord(
  record: CheckpointRecord,
): JsonObject {
  return {
    checkpoint: serializeCheckpoint(record.checkpoint),
    revision: revisionToJson(record.revision),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  return value;
}

function stringField(
  value: Record<string, unknown>,
  key: string,
  fallback = "",
): string {
  const field = value[key];
  if (field === undefined) return fallback;
  if (typeof field !== "string") throw new TypeError(`${key} must be a string`);
  return field;
}

function numberField(
  value: Record<string, unknown>,
  key: string,
  fallback = 0,
): number {
  const field = value[key];
  if (field === undefined) return fallback;
  if (typeof field !== "number" || !Number.isFinite(field))
    throw new TypeError(`${key} must be a finite number`);
  return field;
}

function parseRawMessage(value: unknown): RawMessage {
  const source = record(value, "message");
  const content = source["content"];
  if (content !== null && typeof content !== "string")
    throw new TypeError("message content must be a string or null");
  const calls = source["tool_calls"];
  return {
    role: stringField(source, "role"),
    content,
    ...(calls === undefined
      ? {}
      : {
          toolCalls: Array.isArray(calls)
            ? calls.map((item) => {
                const call = record(item, "tool call");
                const fn = record(call["function"], "tool call function");
                const index = call["index"];
                if (
                  index !== undefined &&
                  (typeof index !== "number" || !Number.isSafeInteger(index))
                ) {
                  throw new TypeError("tool call index must be an integer");
                }
                return {
                  id: stringField(call, "id"),
                  type: stringField(call, "type"),
                  function: {
                    name: stringField(fn, "name"),
                    arguments: stringField(fn, "arguments"),
                  },
                  ...(index === undefined ? {} : { index }),
                };
              })
            : (() => {
                throw new TypeError("tool_calls must be an array");
              })(),
        }),
    ...(source["tool_call_id"] === undefined
      ? {}
      : { toolCallId: stringField(source, "tool_call_id") }),
    ...(source["name"] === undefined
      ? {}
      : { name: stringField(source, "name") }),
  };
}

/** 在持久化边界校验并恢复一个稳定序列化的 Runtime checkpoint。 */
export function parseCheckpoint(value: unknown): Checkpoint {
  const source = record(value, "checkpoint");
  const version = numberField(source, "version");
  if (!Number.isSafeInteger(version) || version <= 0)
    throw new TypeError("checkpoint version must be a positive integer");
  const status = stringField(source, "status");
  if (!isCheckpointStatus(status))
    throw new TypeError("checkpoint status is invalid");
  const messages = source["messages"];
  if (!Array.isArray(messages))
    throw new TypeError("messages must be an array");
  const interruptValue = source["interrupt"];
  const interrupt =
    interruptValue === undefined
      ? undefined
      : record(interruptValue, "interrupt");
  return {
    version,
    threadId: stringField(source, "thread_id"),
    userId: stringField(source, "user_id"),
    status,
    messages: messages.map(parseRawMessage),
    contentRefs: parseContentRefs(source["content_refs"]),
    ...(interrupt === undefined
      ? {}
      : {
          interrupt: {
            toolCallId: stringField(interrupt, "tool_call_id"),
            toolName: stringField(interrupt, "tool_name"),
            arguments: toJsonValue(interrupt["arguments"]),
            payload: toJsonValue(interrupt["payload"]),
          },
        }),
    lastResumeInterrupt: stringField(source, "last_resume_interrupt"),
    ...parseResumeClaim(source["resume_claim"]),
    tokensUsed: numberField(source, "tokens_used"),
    finishReason: stringField(source, "finish_reason"),
  };
}

function isCheckpointStatus(value: string): value is CheckpointStatus {
  return Object.values(CHECKPOINT_STATUSES).some(
    (status: CheckpointStatus): boolean => status === value,
  );
}

function parseContentRefs(value: unknown): ContentRef[] {
  if (value === undefined) return [];
  if (!Array.isArray(value))
    throw new TypeError("content_refs must be an array");
  return value.map((item): ContentRef => {
    const source = record(item, "content reference");
    const metaValue = source["meta"];
    let meta: Record<string, string> | undefined;
    if (metaValue !== undefined) {
      const rawMeta = record(metaValue, "content reference meta");
      meta = {};
      for (const [key, entry] of Object.entries(rawMeta)) {
        if (typeof entry !== "string")
          throw new TypeError("content reference meta values must be strings");
        meta[key] = entry;
      }
    }
    const timestamp = source["timestamp"];
    if (timestamp !== undefined && typeof timestamp !== "number")
      throw new TypeError("content reference timestamp must be a number");
    return {
      kind: stringField(source, "kind"),
      key: stringField(source, "key"),
      ...(source["version"] === undefined
        ? {}
        : { version: stringField(source, "version") }),
      ...(meta === undefined ? {} : { meta }),
      ...(timestamp === undefined ? {} : { timestamp }),
    };
  });
}

function parseResumeClaim(value: unknown): {
  resumeClaim?: ResumeClaim | undefined;
} {
  if (value === undefined) return {};
  const source = record(value, "resume claim");
  return {
    resumeClaim: {
      interruptId: stringField(source, "interrupt_id"),
      requestId: stringField(source, "request_id"),
      response: stringField(source, "response"),
      claimedAt: numberField(source, "claimed_at"),
    },
  };
}
