import { cloneCheckpointRecord } from "../../codec/checkpoint-clone.js";
import type { CheckpointRecord } from "../port/checkpoint-store.js";

/** 内存 Store 私有的恢复回执记录，不属于持久化 Checkpoint 契约。 */
export interface MemoryResumeReceipt {
  readonly interruptId: string;
  readonly response: string;
  readonly completed: boolean;
  readonly record: CheckpointRecord;
}

/**
 * MemoryCheckpointStore 的 resume 回执账本。
 * 只管理幂等键与防御性复制，不决定 claim、CAS 或 fencing 语义。
 */
export class MemoryCheckpointReceiptLedger {
  readonly #receipts = new Map<string, Map<string, MemoryResumeReceipt>>();

  public find(
    threadId: string,
    requestId: string,
  ): MemoryResumeReceipt | undefined {
    const receipt = this.#receipts.get(threadId)?.get(requestId);
    return receipt
      ? { ...receipt, record: cloneCheckpointRecord(receipt.record) }
      : undefined;
  }

  public saveClaim(
    threadId: string,
    requestId: string,
    interruptId: string,
    response: string,
    record: CheckpointRecord,
  ): void {
    this.#threadReceipts(threadId).set(requestId, {
      interruptId,
      response,
      completed: false,
      record: cloneCheckpointRecord(record),
    });
  }

  public saveCompletion(
    threadId: string,
    requestId: string,
    interruptId: string,
    response: string,
    record: CheckpointRecord,
  ): void {
    const receipts = this.#threadReceipts(threadId);
    const previous = receipts.get(requestId);
    receipts.set(requestId, {
      interruptId: previous?.interruptId ?? interruptId,
      response: previous?.response ?? response,
      completed: true,
      record: cloneCheckpointRecord(record),
    });
  }

  public deleteThread(threadId: string): void {
    this.#receipts.delete(threadId);
  }

  #threadReceipts(threadId: string): Map<string, MemoryResumeReceipt> {
    const receipts =
      this.#receipts.get(threadId) ?? new Map<string, MemoryResumeReceipt>();
    this.#receipts.set(threadId, receipts);
    return receipts;
  }
}
