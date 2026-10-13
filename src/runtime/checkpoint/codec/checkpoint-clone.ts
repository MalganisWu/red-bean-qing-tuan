import type { ContentRef } from "../../../protocol/content-reference.js";
import { toJsonValue } from "../../../protocol/json.js";
import type { Interrupt } from "../../../protocol/interrupt.js";
import type { RawMessage } from "../../../protocol/message.js";
import type { Checkpoint } from "../model/checkpoint.js";
import type { CheckpointRecord } from "../store/port/checkpoint-store.js";

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

function cloneContentRef(reference: ContentRef): ContentRef {
  return {
    kind: reference.kind,
    key: reference.key,
    ...(reference.version ? { version: reference.version } : {}),
    ...(reference.meta ? { meta: { ...reference.meta } } : {}),
    ...(reference.timestamp !== undefined
      ? { timestamp: reference.timestamp }
      : {}),
    ...(reference.fetch ? { fetch: reference.fetch } : {}),
  };
}

function cloneInterrupt(interrupt: Interrupt): Interrupt {
  return {
    toolCallId: interrupt.toolCallId,
    toolName: interrupt.toolName,
    arguments: toJsonValue(interrupt.arguments),
    payload: toJsonValue(interrupt.payload),
  };
}

/**
 * 深拷贝 Checkpoint，确保 Store 与 Runtime 不共享任何可变内部对象。
 *
 * 逐字段重建而不是 `structuredClone`：`ContentRef.fetch` 是一个函数，
 * 结构化拷贝会直接失败，而它必须按引用原样带过去。
 * 可选字段一律用条件展开，避免把 `undefined` 显式写进对象——
 * 序列化与快照比对都依赖「可选字段缺席」与「显式为 undefined」是同一件事。
 *
 * @param checkpoint - 待拷贝的检查点；调用方仍持有原对象的所有权，本函数不修改它，返回的副本与入参无共享可变结构
 * @returns 与入参值相等但完全独立的检查点，Store 侧可安全持有而不影响 Runtime 继续推进
 */
export function cloneCheckpoint(checkpoint: Checkpoint): Checkpoint {
  return {
    version: checkpoint.version,
    threadId: checkpoint.threadId,
    userId: checkpoint.userId,
    status: checkpoint.status,
    messages: checkpoint.messages.map(cloneMessage),
    contentRefs: checkpoint.contentRefs.map(cloneContentRef),
    ...(checkpoint.interrupt
      ? { interrupt: cloneInterrupt(checkpoint.interrupt) }
      : {}),
    ...(checkpoint.resumeClaim
      ? { resumeClaim: { ...checkpoint.resumeClaim } }
      : {}),
    lastResumeInterrupt: checkpoint.lastResumeInterrupt,
    tokensUsed: checkpoint.tokensUsed,
    finishReason: checkpoint.finishReason,
  };
}

/**
 * 深拷贝整条记录（checkpoint + revision）；Store 的每个出入口都该经过它。
 *
 * @param record - 带版本号的检查点记录；revision 是 CAS 的比较依据，随 checkpoint 一起复制以免两侧版本失配
 * @returns 与入参同值的独立记录，可以被 Store 缓存或跨线程传递而不与 Runtime 争用内部对象
 */
export function cloneCheckpointRecord(
  record: CheckpointRecord,
): CheckpointRecord {
  return {
    checkpoint: cloneCheckpoint(record.checkpoint),
    revision: record.revision,
  };
}
