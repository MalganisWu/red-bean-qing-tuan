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

/** 隔离调用方可变引用，确保 Store 与 Runtime 不共享 Checkpoint 内部对象。 */
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

export function cloneCheckpointRecord(
  record: CheckpointRecord,
): CheckpointRecord {
  return {
    checkpoint: cloneCheckpoint(record.checkpoint),
    revision: record.revision,
  };
}
