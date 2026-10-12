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

/**
 * JSON 没有 bigint，只能降级为 number；超出安全整数范围即拒绝而不是静默截断——
 * 一个悄悄变形的 revision 会让 CAS 比较在两侧都「看起来合理」地失败。
 */
function revisionToJson(revision: bigint): number {
  const value = Number(revision);
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError("checkpoint revision exceeds JSON safe integer range");
  }
  return value;
}

/**
 * 将 Runtime Checkpoint 写成稳定、宿主中立的 JSON 结构。
 *
 * 两条约定贯穿本函数：
 * - **空值即缺席**：空串、0、空数组一律不写进 payload。宿主拿到的 JSON 因此只包含
 *   「确实有内容」的字段，同一状态的序列化结果逐字节稳定，可以直接参与快照比对。
 * - **wire 用 snake_case**：持久化格式与 TypeScript 侧命名解耦，
 *   字段改名不会波及已落盘的存量数据。
 */
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

/**
 * 反序列化一条消息。`content` 允许 null（工具调用轮次的 assistant 消息就没有正文），
 * 其余字段严格按类型校验；`tool_calls` 一旦出现就必须是数组，不允许退化成单个对象。
 */
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

/**
 * 在持久化边界校验并恢复一个稳定序列化的 Runtime checkpoint。
 *
 * 这是不可信输入（宿主数据库、跨进程传输）进入领域层的唯一入口，因此逐字段做运行时校验，
 * 不用类型断言代替：形状不对就抛 TypeError，而不是让脏数据带着 `as` 往后流。
 * 注意 `version` 必须为正——0 只属于尚未落盘的内存记录，不是合法的持久化状态。
 */
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

/**
 * 反序列化内容引用。`meta` 的值统一限定为 string：
 * 它是宿主注入的检索提示（桶名、路径前缀一类），放开成任意 JSON 会让
 * 「谁负责解释这个值」失去边界。
 */
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
