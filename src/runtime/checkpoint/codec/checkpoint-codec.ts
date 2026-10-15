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
 *
 * @param revision - 待降级的 bigint 版本号；为负或超出安全整数范围即抛 RangeError
 * @returns 可安全写入 JSON 的 number 形式版本号
 */
function revisionToJson(revision: bigint): number {
  const value = Number(revision);
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError("checkpoint revision 超出 JSON 安全整数范围");
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
 *
 * @param checkpoint - 内存态的检查点；本函数只读不改，调用方保留其所有权
 * @returns 可直接 JSON.stringify 或落盘的对象；同一状态重复序列化逐字节相同，可用于快照比对
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

/**
 * 序列化整条记录；revision 超出 JSON 安全整数范围时抛错，不静默截断。
 *
 * @param record - 带版本号的检查点记录；revision 一并写入，供读回侧做 CAS 比较
 * @returns 含 checkpoint 与 revision 两个字段的宿主中立对象
 */
export function serializeCheckpointRecord(
  record: CheckpointRecord,
): JsonObject {
  return {
    checkpoint: serializeCheckpoint(record.checkpoint),
    revision: revisionToJson(record.revision),
  };
}

/**
 * 判断一个未知值是否为普通对象（既非 null 也非数组）。
 *
 * 反序列化边界的每一步形状校验都从它开始：只有先确定是对象，才能安全按键取值。
 *
 * @param value - 来自不可信 JSON 的任意值
 * @returns 是普通对象时为 true，`null` 与数组都返回 false
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * 校验并收窄未知值为普通对象，否则抛出带标签的 TypeError。
 *
 * `label` 用于在错误里指明是哪个字段形状不对，让宿主的日志能直接定位到出错的嵌套层级。
 *
 * @param value - 待校验的未知值
 * @param label - 出错信息里使用的位置标签，便于宿主定位脏数据来源
 * @returns 收窄后的普通对象
 */
function record(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new TypeError(`${label} 必须是对象`);
  }
  return value;
}

/**
 * 读取一个字符串字段：缺席时取 `fallback`，存在但非字符串即抛错。
 *
 * 「缺席」与「显式为 null」都按缺席处理是不允许的——null 会被判为非字符串而抛错，
 * 避免脏数据悄悄退化成默认值。
 *
 * @param value - 已确认是对象的来源
 * @param key - 要读取的字段名
 * @param fallback - 字段缺席时返回的默认值
 * @returns 字段的字符串值或 `fallback`
 */
function stringField(
  value: Record<string, unknown>,
  key: string,
  fallback = "",
): string {
  const field = value[key];
  if (field === undefined) return fallback;
  if (typeof field !== "string") throw new TypeError(`${key} 必须是字符串`);
  return field;
}

/**
 * 读取一个有限数字段：缺席时取 `fallback`，存在但非有限数即抛错。
 *
 * 显式拒绝 `NaN` 与 `Infinity`——它们能通过 `typeof === "number"` 却无法安全落盘。
 *
 * @param value - 已确认是对象的来源
 * @param key - 要读取的字段名
 * @param fallback - 字段缺席时返回的默认值
 * @returns 字段的有限数值或 `fallback`
 */
function numberField(
  value: Record<string, unknown>,
  key: string,
  fallback = 0,
): number {
  const field = value[key];
  if (field === undefined) return fallback;
  if (typeof field !== "number" || !Number.isFinite(field))
    throw new TypeError(`${key} 必须是有限数字`);
  return field;
}

/**
 * 反序列化一次工具调用；`index` 可缺省，给了就必须是安全整数（流式增量靠它归位）。
 *
 * @param item - 来自 `tool_calls` 数组的一项，未经验证
 * @returns 校验通过的工具调用对象，`index` 仅在实际存在时出现
 */
function parseToolCall(item: unknown) {
  const call = record(item, "tool call");
  const fn = record(call["function"], "tool call function");
  const index = call["index"];
  if (
    index !== undefined &&
    (typeof index !== "number" || !Number.isSafeInteger(index))
  ) {
    throw new TypeError("工具调用下标必须是整数");
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
}

/**
 * 反序列化一条消息。`content` 允许 null（工具调用轮次的 assistant 消息就没有正文），
 * 其余字段严格按类型校验；`tool_calls` 一旦出现就必须是数组，不允许退化成单个对象。
 *
 * @param value - 来自持久化 payload 的一条消息，未经验证
 * @returns 校验通过后重建的领域消息对象
 */
function parseRawMessage(value: unknown): RawMessage {
  const source = record(value, "message");
  const content = source["content"];
  if (content !== null && typeof content !== "string")
    throw new TypeError("消息内容必须是字符串或 null");
  const calls = source["tool_calls"];
  return {
    role: stringField(source, "role"),
    content,
    ...(calls === undefined
      ? {}
      : {
          toolCalls: Array.isArray(calls)
            ? calls.map(parseToolCall)
            : (() => {
                throw new TypeError("tool_calls 必须是数组");
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
 *
 * @param value - 来自宿主数据库或跨进程传输的不可信值；形状或字段类型不符即抛 TypeError，绝不带脏数据向后流
 * @returns 校验通过后重建的领域对象检查点，可安全交给 Runtime 继续执行
 */
export function parseCheckpoint(value: unknown): Checkpoint {
  const source = record(value, "checkpoint");
  const version = numberField(source, "version");
  if (!Number.isSafeInteger(version) || version <= 0)
    throw new TypeError("checkpoint version 必须是正整数");
  const status = stringField(source, "status");
  if (!isCheckpointStatus(status))
    throw new TypeError("checkpoint status 取值非法");
  const messages = source["messages"];
  if (!Array.isArray(messages)) throw new TypeError("messages 必须是数组");
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

/**
 * 判断一个字符串是否为已知的 checkpoint 状态。
 *
 * 状态取自 `CHECKPOINT_STATUSES` 常量，读回未知状态即视为数据损坏而非向前兼容。
 *
 * @param value - 从 payload 读到的 `status` 字符串
 * @returns 命中已知状态时为 true
 */
function isCheckpointStatus(value: string): value is CheckpointStatus {
  return Object.values(CHECKPOINT_STATUSES).some(
    (status: CheckpointStatus): boolean => status === value,
  );
}

/**
 * 反序列化内容引用。`meta` 的值统一限定为 string：
 * 它是宿主注入的检索提示（桶名、路径前缀一类），放开成任意 JSON 会让
 * 「谁负责解释这个值」失去边界。
 *
 * @param value - payload 里的 `content_refs` 字段；缺席视为空数组，存在则必须是数组
 * @returns 逐项校验通过的内容引用列表
 */
function parseContentRefs(value: unknown): ContentRef[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new TypeError("content_refs 必须是数组");
  return value.map(parseContentRef);
}

/**
 * 反序列化单个内容引用；`meta` 的值只允许 string，见上方 `parseContentRefs` 的说明。
 *
 * @param item - `content_refs` 数组里的一项，未经验证
 * @returns 校验通过的内容引用；可选字段仅在存在时出现
 */
function parseContentRef(item: unknown): ContentRef {
  const source = record(item, "content reference");
  const metaValue = source["meta"];
  let meta: Record<string, string> | undefined;
  if (metaValue !== undefined) {
    const rawMeta = record(metaValue, "content reference meta");
    meta = {};
    for (const [key, entry] of Object.entries(rawMeta)) {
      if (typeof entry !== "string")
        throw new TypeError("内容引用的 meta 值必须是字符串");
      meta[key] = entry;
    }
  }
  const timestamp = source["timestamp"];
  if (timestamp !== undefined && typeof timestamp !== "number")
    throw new TypeError("内容引用的 timestamp 必须是数字");
  return {
    kind: stringField(source, "kind"),
    key: stringField(source, "key"),
    ...(source["version"] === undefined
      ? {}
      : { version: stringField(source, "version") }),
    ...(meta === undefined ? {} : { meta }),
    ...(timestamp === undefined ? {} : { timestamp }),
  };
}

/**
 * 反序列化恢复认领：缺席即返回空对象，存在则字段必须齐全。
 *
 * 认领记录一旦落盘就代表一次 resume 所有权，字段缺失属于数据损坏，
 * 因此这里不做部分填充，而是整体校验。
 *
 * @param value - payload 里的 `resume_claim` 字段；`undefined` 表示尚无认领
 * @returns 含 `resumeClaim` 的对象，或缺席时为空对象
 */
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
