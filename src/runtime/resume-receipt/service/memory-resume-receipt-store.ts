import type { ResumeRequest } from "../../../runtime/run/model/runtime-request.js";
import type { RuntimeResult } from "../../../runtime/run/result/runtime-result.js";
import { cloneRuntimeResult } from "../../../runtime/run/result/runtime-result-mapper.js";
import type {
  ResumeReceipt,
  ResumeReceiptStore,
} from "../port/resume-receipt-store.js";

/**
 * 使用进程内 Map 保存幂等收据；Runtime 关闭后不承诺保留。
 *
 * 这是**无 Store 模式**下唯一的幂等来源，因此它的生命周期就是进程生命周期：
 * 跨进程重启后同一 resume 请求会被当成新请求再跑一遍。需要跨进程幂等的宿主必须接入 CheckpointStore。
 *
 * 每条收据按 `receiptKeys` 返回的**多个键**各存一份（requestId 与 interruptId），
 * 因此调用方用哪把钥匙来查都能命中；缺失 requestId 时退化为只用 interruptId。
 */
export class MemoryResumeReceiptStore implements ResumeReceiptStore {
  /** threadId → (收据键 → 收据) 的两层 Map；同一条收据会按它的多个键各存一份。 */
  readonly #receipts = new Map<string, Map<string, ResumeReceipt>>();

  /**
   * 按 `receiptKeys` 的顺序逐个查找，第一个命中即返回。
   * @param threadId - 收据所属的 thread；该 thread 无记录时直接返回 undefined。
   * @param request - 用于推导查找键的恢复请求；requestId 缺失时退化为只按 interruptId 查。
   * @returns 命中的收据本体（未拷贝）；调用方不得就地改写它。
   */
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

  /**
   * 同一条收据写入它的全部键，因此用 requestId 或 interruptId 查询都能命中。
   * @param threadId - 收据归属的 thread。
   * @param request - 产生该结果（或失败）的恢复请求；其 interruptId/requestId/response 成为重放时的幂等比对项。
   * @param result - 本次恢复的终态结果，会被深拷贝后存入，不与调用方共享引用。
   * @param error - 失败原因；undefined 表示成功，非 undefined 时重放会照样以失败返回。
   */
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

/**
 * 一次请求对应的全部查找键。
 *
 * 两个键各自带 `request` / `interrupt` 前缀，并以 NUL 分隔：
 * 两类 ID 都由宿主生成，不排除出现相同字符串，加前缀才能保证
 * 「requestId 恰好等于某个 interruptId」时不会串号；
 * 选 NUL 而不是普通字符做分隔，是因为它不可能出现在正常 ID 里。
 * 没有 requestId 时退化为只用 interruptId 一个键。
 *
 * @param request - 待推导的恢复请求；requestId 缺失时只产出 interruptId 一个键
 * @returns 该请求对应的全部查找键，按优先级排列
 */
function receiptKeys(request: ResumeRequest): readonly string[] {
  const interruptKey = `interrupt\u0000${request.interruptId}`;
  const requestId = request.requestId ?? "";
  return requestId === ""
    ? [interruptKey]
    : [`request\u0000${requestId}`, interruptKey];
}
