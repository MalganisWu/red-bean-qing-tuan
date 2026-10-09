import assert from "node:assert/strict";

import { cloneCheckpoint } from "../../runtime/checkpoint/codec/checkpoint-clone.js";
import { CHECKPOINT_STATUSES } from "../../runtime/checkpoint/checkpoint-status.js";
import type { Checkpoint } from "../../runtime/checkpoint/model/checkpoint.js";
import { CheckpointStoreError } from "../../runtime/checkpoint/store/checkpoint-store-error.js";
import type {
  CheckpointRecord,
  CheckpointStore,
} from "../../runtime/checkpoint/store/port/checkpoint-store.js";
import {
  isRuntimeError,
  type RuntimeErrorCode,
} from "../../runtime/run/error/runtime-error.js";

/** 为每个契约用例提供隔离 CheckpointStore 的工厂。 */
export type CheckpointStoreContractFactory = () =>
  CheckpointStore | Promise<CheckpointStore>;

/** 下游 CheckpointStore 契约套件的能力声明与测试生命周期配置。 */
export interface CheckpointStoreContractOptions {
  readonly supportsFencing?: boolean | undefined;
  readonly signal?: AbortSignal | undefined;
  readonly dispose?:
    ((store: CheckpointStore) => void | Promise<void>) | undefined;
  readonly afterCase?: ((name: string) => void | Promise<void>) | undefined;
}

/** 单个 CheckpointStore 契约用例获得的隔离上下文。 */
export interface ContractContext {
  readonly signal: AbortSignal;
  readonly freshStore: () => Promise<CheckpointStore>;
}

/** 可由契约套件统一执行的命名测试用例。 */
export interface ContractCase {
  readonly name: string;
  readonly run: (context: ContractContext) => Promise<void>;
}

export function checkpointFor(
  threadId: string,
  userId: string,
  content: string,
): Checkpoint {
  return {
    version: 1,
    threadId,
    userId,
    status: CHECKPOINT_STATUSES.COMPLETED,
    messages: [{ role: "assistant", content }],
    contentRefs: [],
    lastResumeInterrupt: "",
    tokensUsed: 0,
    finishReason: "stop",
  };
}

export function suspendedCheckpoint(
  threadId: string,
  userId: string,
  interruptId: string,
): Checkpoint {
  return {
    ...checkpointFor(threadId, userId, "waiting"),
    status: CHECKPOINT_STATUSES.SUSPENDED,
    interrupt: {
      toolCallId: interruptId,
      toolName: "ask",
      arguments: { question: "continue?" },
      payload: { kind: "confirmation" },
    },
  };
}

export function withMessage(
  checkpoint: Checkpoint,
  content: string,
): Checkpoint {
  return {
    ...cloneCheckpoint(checkpoint),
    messages: [{ role: "assistant", content }],
  };
}

export function firstMessageContent(record: CheckpointRecord): string | null {
  const message = record.checkpoint.messages[0];
  assert.ok(message, "checkpoint must contain a message");
  return message.content;
}

export function assertOriginalCopy(record: CheckpointRecord): void {
  assert.equal(firstMessageContent(record), "original");
  const message = record.checkpoint.messages[0];
  assert.equal(message?.toolCalls?.[0]?.function.name, "ask");
  assert.equal(record.checkpoint.contentRefs[0]?.meta?.["state"], "original");
  assert.deepEqual(record.checkpoint.interrupt?.arguments, {
    argument: "original",
  });
  assert.deepEqual(record.checkpoint.interrupt?.payload, {
    payload: "original",
  });
}

export async function expectStoreError(
  operation: Promise<unknown>,
  code: RuntimeErrorCode,
): Promise<CheckpointStoreError> {
  try {
    await operation;
  } catch (error: unknown) {
    assert.equal(
      isRuntimeError(error, code),
      true,
      `expected RuntimeError code ${code}`,
    );
    assert.equal(
      error instanceof CheckpointStoreError,
      true,
      `expected CheckpointStoreError for ${code}`,
    );
    if (error instanceof CheckpointStoreError) return error;
    throw error;
  }
  assert.fail(`expected CheckpointStoreError code ${code}`);
}

export async function expectRuntimeError(
  operation: Promise<unknown>,
  code: RuntimeErrorCode,
): Promise<void> {
  try {
    await operation;
  } catch (error: unknown) {
    assert.equal(
      isRuntimeError(error, code),
      true,
      `expected RuntimeError code ${code}`,
    );
    return;
  }
  assert.fail(`expected RuntimeError code ${code}`);
}

export function isCheckpointStore(value: unknown): value is CheckpointStore {
  return (
    typeof value === "object" &&
    value !== null &&
    "load" in value &&
    typeof value.load === "function" &&
    "save" in value &&
    typeof value.save === "function" &&
    "consumeInterrupt" in value &&
    typeof value.consumeInterrupt === "function" &&
    "delete" in value &&
    typeof value.delete === "function"
  );
}
