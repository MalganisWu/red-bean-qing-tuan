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

  public read(threadId: string, fileKey: string): FileReadRecord | undefined {
    return this.#byThread.get(threadId)?.get(fileKey);
  }

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

  public forget(threadId: string, fileKey: string): void {
    const existing = this.#byThread.get(threadId);
    if (existing === undefined) return;
    existing.delete(fileKey);
    if (existing.size === 0) this.#byThread.delete(threadId);
  }
}
