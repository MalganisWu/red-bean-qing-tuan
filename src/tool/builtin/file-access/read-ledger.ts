import type {
  FileReadLedger,
  FileReadRecord,
} from "./port/file-read-ledger.js";

/**
 * 进程内账本参考实现，供单进程宿主与契约验证使用，`implements` 契约见同能力 `port/`。
 *
 * 只保存内存状态，随进程结束消失；跨进程一致性与持久化属于宿主。
 * 外层按 conversation、内层按文件路径分桶，而不是拼接成单个字符串键：`threadId` 由宿主提供，
 * 内容不可假定，任何「分隔符拼接」都可能被含分隔符的 `threadId` 撞键。嵌套结构不依赖编码假设。
 */
export class MemoryFileReadLedger implements FileReadLedger {
  readonly #byThread = new Map<string, Map<string, FileReadRecord>>();

  /**
   * 查询某 conversation 对某文件的最近一次读取记录。
   *
   * @param threadId - conversation 标识，由宿主提供
   * @param fileKey - 文件的绝对化键，由 `ledgerFileKey` 统一
   * @returns 命中时返回读取记录，未记录过时返回 `undefined`
   */
  public read(threadId: string, fileKey: string): FileReadRecord | undefined {
    return this.#byThread.get(threadId)?.get(fileKey);
  }

  /**
   * 记录一次读取，覆盖该文件此前的记录。
   *
   * @param threadId - conversation 标识，由宿主提供
   * @param fileKey - 文件的绝对化键，由 `ledgerFileKey` 统一
   * @param record - 本次读取的内容版本与范围，供写入闸门比对
   */
  public record(
    threadId: string,
    fileKey: string,
    record: FileReadRecord,
  ): void {
    const existing = this.#byThread.get(threadId);
    if (existing === undefined) {
      this.#byThread.set(threadId, new Map([[fileKey, record]]));
      return;
    }
    existing.set(fileKey, record);
  }

  /**
   * 作废某文件的读取记录，写入后调用以避免陈旧授权被复用。
   *
   * @param threadId - conversation 标识，由宿主提供
   * @param fileKey - 文件的绝对化键，由 `ledgerFileKey` 统一
   */
  public forget(threadId: string, fileKey: string): void {
    const existing = this.#byThread.get(threadId);
    if (existing === undefined) return;
    existing.delete(fileKey);
    if (existing.size === 0) this.#byThread.delete(threadId);
  }
}
