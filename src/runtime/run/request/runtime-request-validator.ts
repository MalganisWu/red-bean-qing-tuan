import type {
  AgentRequest,
  ResumeRequest,
} from "../../../runtime/run/model/runtime-request.js";
import {
  RUNTIME_ERROR_CODES,
  RuntimeError,
} from "../../../runtime/run/error/runtime-error.js";
import { cloneRuntimeMessages } from "../../../runtime/run/result/runtime-result-mapper.js";
import type { RawMessage } from "../../../protocol/message.js";
import {
  failRuntimeExecution,
  failedRuntimeResult,
} from "../error/runtime-execution-error.js";

/** 通过互斥项、身份及 Store 模式校验后的 run 输入。 */
export interface ValidatedRunRequest {
  readonly threadId: string;
  readonly userId: string;
  readonly fencingToken: bigint;
  readonly messages: readonly RawMessage[];
}

/** 通过身份和 Store 模式校验后的 resume 输入。 */
export interface ValidatedResumeRequest {
  readonly threadId: string;
  readonly fencingToken: bigint;
}

/**
 * 校验 run 输入组合，并只返回后续编排需要的规范化字段。
 *
 * 整个校验围绕**两种模式互斥**展开。调用方必须二选一，不能混用：
 * - **state 模式**（无 Store）：调用方自己带着完整 Checkpoint / 历史来，Runtime 不碰任何持久化。
 *   代价是没有 CAS、fencing 和幂等回放——那些能力由 Store 提供。
 * - **Store 模式**：状态由 Store 持有，因此 `state`、`history` 一律禁止传入
 *   （传了就是两套事实来源打架），而 `threadId` 必填。
 *
 * `input` 与 `messages` 也是互斥的：前者是「这一轮用户说了什么」的简写，
 * 后者是完整消息数组。同时给会让人无法判断该以谁为准。
 * @param request - 调用方带来的 run 输入；state/history 与 Store 模式互斥，input 与 messages 互斥。
 * @param storeConfigured - 是否配置了 CheckpointStore；它决定 threadId 是否必填、fencing 与 expectedRevision 是否合法。
 * @returns 只含后续编排所需字段的规范化输入；任何非法组合都以携带失败结果的 RuntimeExecutionError 抛出，不返回错误码。
 */
export function validateRunRequest(
  request: AgentRequest,
  storeConfigured: boolean,
): ValidatedRunRequest {
  const threadId = request.threadId ?? "";
  const userId = request.userId ?? "";
  const input = request.input ?? "";
  const providedMessages = request.messages ?? [];
  if (input !== "" && providedMessages.length > 0) {
    return invalid(
      threadId,
      userId,
      "agent request input and messages are mutually exclusive",
    );
  }
  const messages =
    input === ""
      ? cloneRuntimeMessages(providedMessages)
      : [{ role: "user" as const, content: input }];
  if (messages.length === 0) {
    return invalid(
      threadId,
      userId,
      "agent request must contain input or messages",
    );
  }
  const fencingToken = request.fencingToken ?? 0n;
  if (request.state && storeConfigured) {
    return invalid(
      threadId,
      userId,
      "explicit run state cannot be used with checkpoint store",
    );
  }
  if (request.state && (request.history?.length ?? 0) > 0) {
    return invalid(
      threadId,
      userId,
      "explicit run state and history are mutually exclusive",
    );
  }
  if (storeConfigured && threadId === "") {
    return invalid(
      threadId,
      userId,
      "thread ID is required when checkpoint store is configured",
    );
  }
  if (storeConfigured && (request.history?.length ?? 0) > 0) {
    return invalid(
      threadId,
      userId,
      "explicit history cannot be used with checkpoint store",
    );
  }
  validateStoreOnlyFields(
    storeConfigured,
    fencingToken,
    request.expectedRevision,
    threadId,
    userId,
  );
  return { threadId, userId, fencingToken, messages };
}

/**
 * 校验 resume 身份及 Store 模式约束；Checkpoint 本体由会话协调器验证。
 *
 * `threadId` 可以从 `state` 里补——resume 场景下调用方常常只持有 Checkpoint 本身。
 * 但两处都给了就必须一致，不一致说明调用方搞混了两个 thread。
 * `interruptId` 是恢复的必备信息，缺失直接以 `INTERRUPT_MISMATCH` 失败；
 * Store 模式下还必须有 `requestId`，因为它是这条路径唯一的幂等键。
 * @param request - 调用方带来的 resume 输入；threadId 可由 state 补齐，interruptId 必填。
 * @param storeConfigured - 是否配置了 CheckpointStore；Store 模式下 requestId 是唯一幂等键，因此必填。
 * @returns 规范化后的恢复输入（threadId 与 fencingToken）；校验失败以 RuntimeExecutionError 抛出。
 */
export function validateResumeRequest(
  request: ResumeRequest,
  storeConfigured: boolean,
): ValidatedResumeRequest {
  const userId = request.userId ?? "";
  if (request.state && storeConfigured) {
    return invalid(
      request.threadId ?? "",
      userId,
      "explicit resume state cannot be used with checkpoint store",
    );
  }
  let threadId = request.threadId ?? "";
  if (request.state) {
    if (threadId === "") threadId = request.state.threadId;
    else if (
      request.state.threadId !== "" &&
      request.state.threadId !== threadId
    ) {
      return invalid(
        threadId,
        userId,
        "resume thread ID does not match checkpoint",
      );
    }
  }
  if (threadId === "") {
    return invalid(threadId, userId, "thread ID is required to resume");
  }
  if (request.interruptId === "") {
    const error = new RuntimeError(RUNTIME_ERROR_CODES.INTERRUPT_MISMATCH);
    return failRuntimeExecution(
      failedRuntimeResult(threadId, userId),
      error.message,
      error,
    );
  }
  const fencingToken = request.fencingToken ?? 0n;
  validateStoreOnlyFields(
    storeConfigured,
    fencingToken,
    request.expectedRevision,
    threadId,
    userId,
  );
  if (storeConfigured && (request.requestId ?? "") === "") {
    return invalid(
      threadId,
      userId,
      "request ID is required to resume with checkpoint store",
    );
  }
  return { threadId, fencingToken };
}

/**
 * 拦住只在 Store 模式下成立的字段。
 * 无 Store 却传 `fencingToken` 属于误解协议：没有 Store 就没有高水位可言，
 * 静默忽略会让调用方以为自己拿到了 fencing 保护。传 `expectedRevision` 同理——
 * 没有 Store 就没有 revision 可 CAS。
 */
function validateStoreOnlyFields(
  storeConfigured: boolean,
  fencingToken: bigint,
  expectedRevision: bigint | undefined,
  threadId: string,
  userId: string,
): void {
  if (!storeConfigured && fencingToken !== 0n) {
    const error = new RuntimeError(RUNTIME_ERROR_CODES.FENCING_UNSUPPORTED);
    return failRuntimeExecution(
      failedRuntimeResult(threadId, userId),
      error.message,
      error,
    );
  }
  if (!storeConfigured && expectedRevision !== undefined) {
    return invalid(
      threadId,
      userId,
      "expected revision requires checkpoint store",
    );
  }
}

/**
 * 参数不合法时的统一出口：构造失败结果再抛出 `RuntimeExecutionError`。
 * 返回类型是 `never`，因此调用点写成 `return invalid(...)`，编译期就能保证后续代码不可达。
 */
function invalid(threadId: string, userId: string, message: string): never {
  return failRuntimeExecution(
    failedRuntimeResult(threadId, userId),
    message,
    new Error("invalid request"),
  );
}
