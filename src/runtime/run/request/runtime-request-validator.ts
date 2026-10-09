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

/** 校验 run 输入组合，并只返回后续编排需要的规范化字段。 */
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

/** 校验 resume 身份及 Store 模式约束；Checkpoint 本体由会话协调器验证。 */
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

function invalid(threadId: string, userId: string, message: string): never {
  return failRuntimeExecution(
    failedRuntimeResult(threadId, userId),
    message,
    new Error("invalid request"),
  );
}
