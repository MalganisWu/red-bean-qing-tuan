import type { ResumeRequest } from "../model/runtime-request.js";
import type { RuntimeResult } from "../result/runtime-result.js";
import {
  cloneRuntimeResult,
  runtimeResultFromRecord,
} from "../result/runtime-result-mapper.js";
import {
  CONSUME_DISPOSITIONS,
  type ConsumeInterruptResult,
} from "../../checkpoint/store/port/checkpoint-store.js";
import { CHECKPOINT_STATUSES } from "../../checkpoint/checkpoint-status.js";
import type { ResumeReceiptStore } from "../../resume-receipt/port/resume-receipt-store.js";
import { RUNTIME_ERROR_CODES, RuntimeError } from "../error/runtime-error.js";
import { failRuntimeExecution } from "../error/runtime-execution-error.js";
import { validateCheckpointIdentity } from "./runtime-checkpoint-session.js";

/** 无 Store 模式命中进程内 receipt 时，校验幂等身份并返回防御性副本。 */
export function replayStatelessResume(
  receipts: ResumeReceiptStore,
  threadId: string,
  request: ResumeRequest,
): RuntimeResult | undefined {
  const receipt = receipts.find(threadId, request);
  if (!receipt) return undefined;
  if (request.state) {
    validateCheckpointIdentity(request.state, threadId, request.userId ?? "");
  }
  validateCheckpointIdentity(
    receipt.result.checkpoint,
    threadId,
    request.userId ?? "",
  );
  if (
    receipt.interruptId !== request.interruptId ||
    receipt.requestId !== (request.requestId ?? "") ||
    receipt.response !== request.response
  ) {
    const error = new RuntimeError(RUNTIME_ERROR_CODES.IDEMPOTENCY_CONFLICT);
    return failRuntimeExecution(receipt.result, error.message, error);
  }
  if (receipt.error) {
    return failRuntimeExecution(
      receipt.result,
      receipt.error.message,
      receipt.error,
    );
  }
  return cloneRuntimeResult(receipt.result);
}

/** Store 已有 replay/in-progress 结果时在再次执行模型前结束恢复流程。 */
export function resultForConsumedResume(
  consumed: ConsumeInterruptResult,
): RuntimeResult | undefined {
  if (consumed.disposition === CONSUME_DISPOSITIONS.REPLAYED) {
    const result = runtimeResultFromRecord(consumed.record);
    if (
      result.status === CHECKPOINT_STATUSES.FAILED ||
      result.status === CHECKPOINT_STATUSES.CANCELLED
    ) {
      const error = new RuntimeError(RUNTIME_ERROR_CODES.REPLAYED_FAILURE);
      return failRuntimeExecution(result, error.message, error);
    }
    return result;
  }
  if (consumed.disposition === CONSUME_DISPOSITIONS.IN_PROGRESS) {
    const result = runtimeResultFromRecord(consumed.record);
    const error = new RuntimeError(RUNTIME_ERROR_CODES.RESUME_IN_PROGRESS);
    return failRuntimeExecution(result, error.message, error);
  }
  return undefined;
}
