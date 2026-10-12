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
  /**
   * 声明实现是否支持 fencing。为 false 时套件不跑 fencing 用例，
   * 宿主应改为运行 `runCheckpointStoreFencingUnsupportedContract`，
   * 否则「不支持 fencing」会静默等价于「没测过 fencing」。
   */
  readonly supportsFencing?: boolean | undefined;
  /** 覆盖所有用例共用的取消信号；缺省为永不取消的信号。 */
  readonly signal?: AbortSignal | undefined;
  /** 每个用例结束后释放其创建的 Store；失败会被聚合进该用例的失败原因，而不是被吞掉。 */
  readonly dispose?:
    ((store: CheckpointStore) => void | Promise<void>) | undefined;
  /** 用例通过后的钩子，用于重置外部状态；用例本身失败时不会执行。 */
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

/** 构造一个 `completed` 的完整 Checkpoint；`version` 固定为 1，因为 0 只属于未落盘的内存记录。 */
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

/** 构造挂起态 Checkpoint；`interrupt.toolCallId` 即后续 resume 要匹配的 `interruptId`。 */
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

/**
 * 派生一个只替换首条消息内容的副本。
 * 这里的 `cloneCheckpoint` 是刻意的：用例会把这个派生对象当作「新值」喂回去，
 * 若直接共享引用，Store 是否做了防御性复制就永远测不出来。
 */
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

/**
 * 断言记录里仍是写入时的原始值。
 *
 * 用例的套路是：先 `save` 一个带嵌套结构的 Checkpoint，再就地改写调用方持有的那个对象，
 * 然后回读并调用本函数。因此它验证的是 Store 的**防御性复制**契约——
 * 写入与读出都不能与调用方共享可变对象，否则调用方后续的修改会隔着 Store 生效。
 * 覆盖点是逐层的：消息内容与 toolCalls、contentRefs 的 meta、interrupt 的 arguments 与 payload。
 */
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

/**
 * 断言操作以指定的 `CheckpointStoreError` 失败，并把错误对象交给调用方。
 * 比 `expectRuntimeError` 多要求一层：错误必须是 CheckpointStore 自己的错误类型，
 * 这样用例才能继续检查它携带的 `record`（冲突快照）。
 */
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

/** 只校验错误码的宽松版本；用于 fail-closed 类断言，不关心错误由哪个层抛出。 */
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

/**
 * 结构校验：四个方法都得在且是函数。
 * 套件在工厂返回后立刻调用它，是为了让「工厂返回了半成品」在第一时间报出明确的类型错误，
 * 而不是等到某个用例深处出现 `store.load is not a function`。
 */
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
