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
  /** 起点的历史消息；无 Store 且是新 thread 时可能为空。 */
  readonly history: readonly RawMessage[];
  /** 起点携带的内容引用，随上下文一起被恢复。 */
  readonly contentRefs: readonly ContentRef[];
  /** 归一化后的所有者标识；请求未声明时回落到 state 或 Store 的值。 */
  readonly userId: string;
  /** 起点记录中最近一次已消费的中断 ID，用于判定某中断是否已处理过。 */
  readonly lastResumeInterrupt: string;
  /** 起点在 Store 中的版本；无 Store 或新 thread 时为 0n。 */
  readonly revision: bigint;
  /** 非空表示本次调用不该继续执行，调用方应直接返回它（起点已处于挂起或已认领状态）。 */
  readonly terminalResult?: ReturnType<typeof runtimeResultFromRecord>;
}

/**
 * 装载 run 起点并统一处理 identity、revision、resume claim 与 Store 错误语义。
 *
 * 两条来源的优先级与各自的终止条件是这段代码的全部内容：
 * - **显式 `state` 优先**。它带着完整 Checkpoint，无需访问 Store；若其中已有 `interrupt`
 *   或 `resumeClaim`，说明不该继续跑，直接返回终态结果（`terminalResult`）。
 * - **没有 state 才查 Store**。`CHECKPOINT_NOT_FOUND` **不是**错误：它带着一条空记录，
 *   表示这是一次全新运行，照常返回空的起点让上层去创建。
 *
 * 其余判定：`expectedRevision` 不符即 CAS 冲突；存在 `resumeClaim` 表示有别的请求
 * 正在处理，返回 `THREAD_BUSY` 而不是排队等待。
 * @param store - CheckpointStore；为 undefined 表示 state 或无 Store 模式，此时不访问持久化。
 * @param request - run 输入；显式 `state` 优先于 Store，两者都缺时返回空起点让上层创建。
 * @param signal - 取消信号；Store 读取失败（NOT_FOUND 除外）时以携带失败结果的异常抛出。
 * @returns 归一化的运行起点；若已处于挂起或已认领状态，则带 `terminalResult` 让调用方直接返回。
 */
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
    // 显式 state 且处于挂起/已认领状态：这次调用的结果已经由 state 决定，不需要再跑。
    // revision 传 0n 是因为 state 模式没有 Store 的 revision 概念。
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
    // `||=`：请求没带 userId 时才采用 state 里的，调用方显式声明的身份优先。
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
    // NOT_FOUND 携带空记录，是「全新 thread」的正常信号而非故障：拿记录、标记未找到、继续。
    // 其余错误才是真的读失败。
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
  // 新 thread：返回调用方自己带来的 history（若有），revision 用 Store 给的 0。
  if (!found) {
    return { history, contentRefs, userId, lastResumeInterrupt, revision };
  }
  validateCheckpointIdentity(record.checkpoint, threadId, requestedUserId);
  // 已有他人认领在手：本次不能覆盖，直接以当前记录构造 THREAD_BUSY 的结果返回。
  if (record.checkpoint.resumeClaim) {
    const error = new RuntimeError(RUNTIME_ERROR_CODES.THREAD_BUSY);
    return failRuntimeExecution(
      runtimeResultFromRecord(record),
      error.message,
      error,
    );
  }
  // 存在挂起：run 不该继续推进，返回挂起态让调用方改走 resume。
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

/**
 * 以 state 或 Store 原子领取 interrupt，且不承担后续模型执行。
 *
 * 两种模式互斥：
 * - **state 模式**：在克隆出来的 Checkpoint 上直接做状态迁移，不落任何持久化。
 *   三种既有状态各有归宿——同 interrupt 已消费过 → `REPLAYED`；
 *   已有 claim → 同 interrupt 报进行中、不同 interrupt 报忙碌；
 *   否则校验挂起点匹配后落 claim，返回 `CLAIMED`。
 * - **Store 模式**：先 load 校验身份，再把 expectedRevision 交给 Store 去原子消费。
 *   请求没带期望 revision 时用刚读到的值，等价于「以读到的版本为准」。
 * @param store - CheckpointStore；为 undefined 且请求也未带 state 时直接抛错（恢复没有可用起点）。
 * @param threadId - 恢复目标 thread；state 模式会用它补齐 Checkpoint 里缺失的 threadId。
 * @param request - 恢复请求；interruptId 必须匹配当前挂起点，Store 模式下 requestId 是幂等键。
 * @param signal - 取消信号，透传给 Store 的 load 与 consumeInterrupt。
 * @returns 认领或重放结果；只有 disposition 为 CLAIMED 时调用方才应继续执行模型。
 */
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

/**
 * 校验 Checkpoint 属于请求所指的 thread 与用户。
 *
 * 两类不匹配走**不同的错误**，这个区别是刻意的：
 * - `threadId` 对不上是调用方把两个对象拼错了（编程错误），用普通 `Error` 直接暴露。
 * - `userId` 对不上是越权，必须伪装成 `CHECKPOINT_NOT_FOUND`，不能让人靠错误码
 *   探测出「这个 thread 存在，只是不属于我」。
 *
 * 任一方的 userId 为空串都视为「未声明身份」，跳过校验。
 * @param checkpoint - 待校验的 Checkpoint；只读取其 threadId 与 userId。
 * @param threadId - 请求声明的 thread；与 Checkpoint 不一致（且 Checkpoint 非空）即抛普通 Error，属调用方的编程错误。
 * @param userId - 请求声明的身份；空串表示未声明而跳过校验，不匹配则以 CHECKPOINT_NOT_FOUND 伪装越权。
 */
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

/**
 * 确认要恢复的正是当前挂起的那个工具调用；「没挂起」与「挂起的是别人」分开报错。
 *
 * @param checkpoint - 待校验的 Checkpoint；以其 interrupt 字段为当前挂起点
 * @param interruptId - 请求要恢复的中断标识；与挂起点 toolCallId 不符即报 INTERRUPT_MISMATCH
 */
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
