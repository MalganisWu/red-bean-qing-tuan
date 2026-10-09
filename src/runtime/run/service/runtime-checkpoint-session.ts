import type {
  AgentRequest,
  ResumeRequest,
} from "../../../runtime/run/model/runtime-request.js";
import {
  cloneRuntimeContentRef,
  cloneRuntimeMessages,
  runtimeResultFromRecord,
} from "../../../runtime/run/result/runtime-result-mapper.js";
import type { ContentRef } from "../../../protocol/content-reference.js";
import type { RawMessage } from "../../../protocol/message.js";
import {
  RUNTIME_ERROR_CODES,
  RuntimeError,
} from "../../../runtime/run/error/runtime-error.js";
import { cloneCheckpoint } from "../../checkpoint/codec/checkpoint-clone.js";
import type { Checkpoint } from "../../checkpoint/model/checkpoint.js";
import { CheckpointStoreError } from "../../checkpoint/store/checkpoint-store-error.js";
import {
  CONSUME_DISPOSITIONS,
  type CheckpointStore,
  type ConsumeInterruptResult,
} from "../../checkpoint/store/port/checkpoint-store.js";
import {
  failRuntimeExecution,
  failedRuntimeResult,
  normalizeRuntimeError,
} from "../error/runtime-execution-error.js";

/** 从显式 state 或 Store 归一化得到的唯一运行起点。 */
export interface LoadedRunCheckpoint {
  readonly history: readonly RawMessage[];
  readonly contentRefs: readonly ContentRef[];
  readonly userId: string;
  readonly lastResumeInterrupt: string;
  readonly revision: bigint;
  readonly terminalResult?: ReturnType<typeof runtimeResultFromRecord>;
}

/** 装载 run 起点并统一处理 identity、revision、resume claim 与 Store 错误语义。 */
export async function loadRunCheckpoint(
  store: CheckpointStore | undefined,
  request: AgentRequest,
  signal: AbortSignal,
): Promise<LoadedRunCheckpoint> {
  const threadId = request.threadId ?? "";
  const requestedUserId = request.userId ?? "";
  let history = cloneRuntimeMessages(request.history ?? []);
  let contentRefs: ContentRef[] = [];
  let userId = requestedUserId;
  let lastResumeInterrupt = "";
  let revision = 0n;

  if (request.state) {
    validateCheckpointIdentity(request.state, threadId, requestedUserId);
    if (request.state.interrupt || request.state.resumeClaim) {
      return {
        history,
        contentRefs,
        userId,
        lastResumeInterrupt,
        revision,
        terminalResult: runtimeResultFromRecord({
          checkpoint: request.state,
          revision: 0n,
        }),
      };
    }
    history = cloneRuntimeMessages(request.state.messages);
    contentRefs = request.state.contentRefs.map(cloneRuntimeContentRef);
    userId ||= request.state.userId;
    lastResumeInterrupt = request.state.lastResumeInterrupt;
  }
  if (!store) {
    return { history, contentRefs, userId, lastResumeInterrupt, revision };
  }

  let record;
  let found = true;
  try {
    record = await store.load(
      {
        threadId,
        userId: requestedUserId,
        fencingToken: request.fencingToken ?? 0n,
      },
      signal,
    );
  } catch (value: unknown) {
    if (
      value instanceof CheckpointStoreError &&
      value.code === RUNTIME_ERROR_CODES.CHECKPOINT_NOT_FOUND &&
      value.record
    ) {
      record = value.record;
      found = false;
    } else {
      const error = normalizeRuntimeError(value);
      return failRuntimeExecution(
        failedRuntimeResult(threadId, requestedUserId),
        `load checkpoint: ${error.message}`,
        value,
      );
    }
  }
  revision = record.revision;
  if (
    request.expectedRevision !== undefined &&
    request.expectedRevision !== revision
  ) {
    const error = new RuntimeError(RUNTIME_ERROR_CODES.REVISION_CONFLICT);
    return failRuntimeExecution(
      failedRuntimeResult(threadId, requestedUserId),
      error.message,
      error,
    );
  }
  if (!found) {
    return { history, contentRefs, userId, lastResumeInterrupt, revision };
  }
  validateCheckpointIdentity(record.checkpoint, threadId, requestedUserId);
  if (record.checkpoint.resumeClaim) {
    const error = new RuntimeError(RUNTIME_ERROR_CODES.THREAD_BUSY);
    return failRuntimeExecution(
      runtimeResultFromRecord(record),
      error.message,
      error,
    );
  }
  if (record.checkpoint.interrupt) {
    return {
      history,
      contentRefs,
      userId,
      lastResumeInterrupt,
      revision,
      terminalResult: runtimeResultFromRecord(record),
    };
  }
  userId ||= record.checkpoint.userId;
  lastResumeInterrupt = record.checkpoint.lastResumeInterrupt;
  history = cloneRuntimeMessages(record.checkpoint.messages);
  contentRefs = record.checkpoint.contentRefs.map(cloneRuntimeContentRef);
  return { history, contentRefs, userId, lastResumeInterrupt, revision };
}

/** 以 state 或 Store 原子领取 interrupt，且不承担后续模型执行。 */
export async function consumeResumeCheckpoint(
  store: CheckpointStore | undefined,
  threadId: string,
  request: ResumeRequest,
  signal: AbortSignal,
): Promise<ConsumeInterruptResult> {
  if (request.state) {
    const checkpoint = cloneCheckpoint(request.state);
    if (checkpoint.threadId === "") checkpoint.threadId = threadId;
    validateCheckpointIdentity(checkpoint, threadId, request.userId ?? "");
    if (checkpoint.lastResumeInterrupt === request.interruptId) {
      return {
        record: { checkpoint, revision: 0n },
        disposition: CONSUME_DISPOSITIONS.REPLAYED,
      };
    }
    if (checkpoint.resumeClaim) {
      const code =
        checkpoint.resumeClaim.interruptId === request.interruptId
          ? RUNTIME_ERROR_CODES.RESUME_IN_PROGRESS
          : RUNTIME_ERROR_CODES.THREAD_BUSY;
      throw new RuntimeError(code);
    }
    validatePendingInterrupt(checkpoint, request.interruptId);
    checkpoint.interrupt = undefined;
    checkpoint.resumeClaim = {
      interruptId: request.interruptId,
      requestId: request.requestId ?? "",
      response: request.response,
      claimedAt: Date.now(),
    };
    return {
      record: { checkpoint, revision: 0n },
      disposition: CONSUME_DISPOSITIONS.CLAIMED,
    };
  }
  if (!store) throw new Error("resume requires state or checkpoint store");
  const userId = request.userId ?? "";
  const fencingToken = request.fencingToken ?? 0n;
  const loaded = await store.load({ threadId, userId, fencingToken }, signal);
  validateCheckpointIdentity(loaded.checkpoint, threadId, userId);
  return store.consumeInterrupt(
    {
      threadId,
      userId,
      interruptId: request.interruptId,
      requestId: request.requestId ?? "",
      response: request.response,
      expectedRevision: request.expectedRevision ?? loaded.revision,
      fencingToken,
    },
    signal,
  );
}

export function validateCheckpointIdentity(
  checkpoint: Checkpoint,
  threadId: string,
  userId: string,
): void {
  if (checkpoint.threadId !== "" && checkpoint.threadId !== threadId) {
    throw new Error("checkpoint thread ID does not match request");
  }
  if (
    userId !== "" &&
    checkpoint.userId !== "" &&
    checkpoint.userId !== userId
  ) {
    throw new RuntimeError(RUNTIME_ERROR_CODES.CHECKPOINT_NOT_FOUND);
  }
}

function validatePendingInterrupt(
  checkpoint: Checkpoint,
  interruptId: string,
): void {
  if (!checkpoint.interrupt) {
    throw new RuntimeError(RUNTIME_ERROR_CODES.CHECKPOINT_NOT_SUSPENDED);
  }
  if (checkpoint.interrupt.toolCallId !== interruptId) {
    throw new RuntimeError(RUNTIME_ERROR_CODES.INTERRUPT_MISMATCH);
  }
}
