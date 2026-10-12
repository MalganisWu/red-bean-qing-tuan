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

/**
 * 无 Store 模式命中进程内 receipt 时，校验幂等身份并返回防御性副本。
 *
 * 这是「宿主没接 CheckpointStore，但同进程内又收到同一个 resume 请求」的兜底路径。
 * 校验顺序：先确认两侧身份都属于这个 thread（state 与 receipt 各查一次，
 * 因为两者可能来自不同的请求），再逐项比对幂等三元组。
 * 原请求失败过的话，重放必须照样以失败返回——把一次失败重放成成功，
 * 会让上层以为工具真的执行完了。
 */
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

/**
 * Store 已有 replay/in-progress 结果时在再次执行模型前结束恢复流程。
 *
 * 返回值语义：**`undefined` 表示「继续往下跑」**，非 undefined 则是可以直接交回给调用方的终态。
 * 三种 disposition 各自对应一条：
 * - `REPLAYED`：这次请求早先已完成，直接返回当时的记录。但记录若是 failed/cancelled，
 *   必须改抛错误——已经失败过的运行不能靠重放变成一次成功。
 * - `IN_PROGRESS`：另一次认领还没落终态，本次只能如实报「进行中」。
 * - `CLAIMED`：本次真的抢到了，交由调用方继续执行模型。
 */
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
