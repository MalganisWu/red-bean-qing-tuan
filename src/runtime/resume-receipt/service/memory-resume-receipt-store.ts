import type { ResumeRequest } from "../../../runtime/run/model/runtime-request.js";
import type { RuntimeResult } from "../../../runtime/run/result/runtime-result.js";
import { cloneRuntimeResult } from "../../../runtime/run/result/runtime-result-mapper.js";
import type {
  ResumeReceipt,
  ResumeReceiptStore,
} from "../port/resume-receipt-store.js";

/** 使用进程内 Map 保存幂等收据；Runtime 关闭后不承诺保留。 */
export class MemoryResumeReceiptStore implements ResumeReceiptStore {
  readonly #receipts = new Map<string, Map<string, ResumeReceipt>>();

  public find(
    threadId: string,
    request: ResumeRequest,
  ): ResumeReceipt | undefined {
    const threadReceipts = this.#receipts.get(threadId);
    if (!threadReceipts) return undefined;
    for (const key of receiptKeys(request)) {
      const receipt = threadReceipts.get(key);
      if (receipt) return receipt;
    }
    return undefined;
  }

  public save(
    threadId: string,
    request: ResumeRequest,
    result: RuntimeResult,
    error: Error | undefined,
  ): void {
    const receipt: ResumeReceipt = {
      interruptId: request.interruptId,
      requestId: request.requestId ?? "",
      response: request.response,
      result: cloneRuntimeResult(result),
      error,
    };
    const threadReceipts =
      this.#receipts.get(threadId) ?? new Map<string, ResumeReceipt>();
    for (const key of receiptKeys(request)) threadReceipts.set(key, receipt);
    this.#receipts.set(threadId, threadReceipts);
  }
}

function receiptKeys(request: ResumeRequest): readonly string[] {
  const interruptKey = `interrupt\u0000${request.interruptId}`;
  const requestId = request.requestId ?? "";
  return requestId === ""
    ? [interruptKey]
    : [`request\u0000${requestId}`, interruptKey];
}
