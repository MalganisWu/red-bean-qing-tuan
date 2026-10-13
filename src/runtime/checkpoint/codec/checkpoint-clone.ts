import type { ContentRef } from "../../../protocol/content-reference.js";
import { toJsonValue } from "../../../protocol/json.js";
import type { Interrupt } from "../../../protocol/interrupt.js";
import type { RawMessage } from "../../../protocol/message.js";
import type { Checkpoint } from "../model/checkpoint.js";
import type { CheckpointRecord } from "../store/port/checkpoint-store.js";

/**
 * 逐字段重建一条消息，`toolCalls` 及其内层 `function` 再各复制一层。
 *
 * 不用 `structuredClone`：消息里可能挂 `ContentRef.fetch` 一类函数字段，结构化拷贝会失败。
 * 只复制真正存在的可选字段，保证副本与入参在序列化视角下逐字节一致。
 *
 * @param message - 待复制的消息；调用方保留原对象所有权，本函数不改它
 * @returns 与入参等值但无共享可变嵌套结构的独立消息
 */
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

/**
 * 逐字段重建一个内容引用；`fetch` 是函数，按引用原样带过去而不是深拷贝。
 *
 * 引用本身不可变，复制只为切断 `meta` 这类对象字段的共享，防止调用方改一处影响另一处。
 *
 * @param reference - 待复制的内容引用；调用方保留其所有权
 * @returns 与入参等值的独立引用，`fetch` 仍指向同一个函数
 */
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

/**
 * 逐字段重建一个中断；`arguments` / `payload` 先经 `toJsonValue` 归一到可选 JSON 值。
 *
 * 中断会作为 pending 状态随 checkpoint 落盘与回读，归一在这里完成可避免两侧对
 * 「哪些值算合法 JSON」判断不一致。
 *
 * @param interrupt - 待复制的中断；调用方保留其所有权
 * @returns 与入参等值且值为中性 JSON 的独立中断
 */
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
