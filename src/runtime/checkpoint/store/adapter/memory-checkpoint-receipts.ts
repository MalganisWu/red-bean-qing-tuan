import { cloneCheckpointRecord } from "../../codec/checkpoint-clone.js";
import type { CheckpointRecord } from "../port/checkpoint-store.js";

/** 内存 Store 私有的恢复回执记录，不属于持久化 Checkpoint 契约。 */
export interface MemoryResumeReceipt {
  /** 被恢复的中断标识；首次认领时写入后固化，供重放时校验身份。 */
  readonly interruptId: string;
  /** 恢复时提交的应答原文；同样在首次认领时固化，终态写入不得篡改。 */
  readonly response: string;
  /** 是否已完成；true 表示终态已落盘，同 requestId 的重放直接返回结果，false 则返回进行中。 */
  readonly completed: boolean;
  /** 认领或完成时刻的检查点记录；出入账本两侧都深拷贝，与调用方互不共享。 */
  readonly record: CheckpointRecord;
}

/**
 * MemoryCheckpointStore 的 resume 回执账本。
 * 只管理幂等键与防御性复制，不决定 claim、CAS 或 fencing 语义。
 */
export class MemoryCheckpointReceiptLedger {
  /** 按 threadId 分桶的幂等账本，桶内再按 requestId 索引回执；分桶让跨 thread 的同名 requestId 互不可见。 */
  readonly #receipts = new Map<string, Map<string, MemoryResumeReceipt>>();

  /**
   * 按幂等键查回执，返回的是拷贝，调用方改不到账本里的原件。
   *
   * @param threadId - 归属的会话标识；账本按 thread 分桶，跨 thread 的 requestId 互不可见
   * @param requestId - 恢复请求的幂等键；同一 thread 下重复的键指向同一条回执
   * @returns 回执的快照（含深拷贝的 record）；从未认领过时返回 undefined，调用方据此走首次恢复路径
   */
  public find(
    threadId: string,
    requestId: string,
  ): MemoryResumeReceipt | undefined {
    const receipt = this.#receipts.get(threadId)?.get(requestId);
    return receipt
      ? { ...receipt, record: cloneCheckpointRecord(receipt.record) }
      : undefined;
  }

  /**
   * 记下首次认领，回执进入未完成态；重复认领同一 requestId 会覆盖旧条目。
   *
   * @param threadId - 归属的会话标识，决定回执落在哪个桶
   * @param requestId - 本次恢复请求的幂等键，后续完成写入凭它归位
   * @param interruptId - 被恢复的中断标识，写入后即固化，用于重放时的身份校验
   * @param response - 恢复时提交的应答内容，与 interruptId 一同固化
   * @param record - 认领时刻的检查点记录，入库前深拷贝，与调用方的副本互不影响
   */
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

  /**
   * 把回执翻成已完成，并更新为终态记录。
   * `interruptId`/`response` 保留首次认领时写入的值：终态写入只是结束这次请求，
   * 不应借此改写「这次请求本来是什么」，否则后续重放的身份校验会失去参照。
   *
   * @param threadId - 归属的会话标识
   * @param requestId - 要收尾的恢复请求；若该键此前未认领过，则按本次入参新建一条已完成回执
   * @param interruptId - 中断标识；仅在无既有认领记录时采用，否则沿用首次认领的值
   * @param response - 应答内容；同样仅在无既有认领记录时采用，避免终态写入篡改请求身份
   * @param record - 完成时刻的检查点记录，入库前深拷贝
   */
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

  /**
   * 随 thread 删除一并清空其回执桶，避免已删线索的恢复请求命中陈旧回执。
   *
   * @param threadId - 要清除的会话标识；不存在时静默返回，删除本身幂等
   */
  public deleteThread(threadId: string): void {
    this.#receipts.delete(threadId);
  }

  /**
   * 取某个 thread 的回执桶，不存在则就地建空桶。
   *
   * 先建桶再写入，保证后续对同一 thread 的查询拿到的是同一个 Map 实例，
   * 而不是每次各建一个新桶导致写入丢失。
   *
   * @param threadId - 会话标识，决定回执落在哪个桶
   * @returns 该 thread 对应的回执 Map，新桶为空
   */
  #threadReceipts(threadId: string): Map<string, MemoryResumeReceipt> {
    const receipts =
      this.#receipts.get(threadId) ?? new Map<string, MemoryResumeReceipt>();
    this.#receipts.set(threadId, receipts);
    return receipts;
  }
}
