import type { FileIdentity } from "../model/file-identity.js";

/**
 * 一次成功读取留下的记录：这份内容的版本，以及当时读到的行范围。
 *
 * 版本使用 `mtimeMs`（毫秒）而不是秒级截断值。写入类工具据此判断「模型手里的内容是否仍是当前内容」，
 * 秒级粒度会让同一秒内的改动被误判为未变更，因此这里必须严于展示层使用的时间精度。
 */
export interface FileReadRecord {
  /** 读取那一刻文件修改时间的毫秒值，写入闸门据此判断内容是否仍是读到的版本。 */
  readonly mtimeMs: number;
  /** 本次读取起始的字节偏移，与 `limit` 一起界定读到的范围。 */
  readonly offset: number;
  /** 本次读取的最大字节数，用于区分「读全了」与「只读了片段」。 */
  readonly limit: number;
  /** 读取时记录的文件身份，用于发现同一路径已被替换成另一个文件对象。 */
  readonly identity: FileIdentity;
}

/**
 * 按 conversation 记录「已读过哪份文件、读到的是哪个版本」的账本。
 *
 * 记录描述的是「这个 conversation 的上下文里有没有这份内容」，不是文件的固有属性，因此必须按
 * `threadId` 隔离：若只按路径记录，另一个从未读过该文件的会话会收到一句它无法兑现的提示。
 *
 * 写入类工具依赖该账本实现「先读后写」，所以读取工具与写入工具必须共用同一个账本实例，
 * 由宿主在 composition root 显式创建并注入；各工具自建默认实例会让闸门永远读不到读取记录。
 * 默认实现为 `MemoryFileReadLedger`（进程内，只用于单进程宿主与契约验证）。
 */
export interface FileReadLedger {
  /**
   * 查询某个 conversation 对某个文件的最近一次读取记录。
   *
   * @param threadId - conversation 标识，用于隔离不同会话的上下文
   * @param fileKey - 由 `ledgerFileKey` 统一生成的绝对化文件键
   * @returns 命中时返回读取记录，未读过时返回 `undefined`
   */
  read(threadId: string, fileKey: string): FileReadRecord | undefined;
  /**
   * 记录一次成功读取，覆盖同一 conversation 对该文件的旧记录。
   *
   * @param threadId - conversation 标识，用于隔离不同会话的上下文
   * @param fileKey - 由 `ledgerFileKey` 统一生成的绝对化文件键
   * @param record - 本次读取的内容版本与范围，供写入闸门比对
   */
  record(threadId: string, fileKey: string, record: FileReadRecord): void;
  /**
   * 丢弃记录，用于内容已被重新取回或已确认失效的场景。
   *
   * @param threadId - conversation 标识，用于隔离不同会话的上下文
   * @param fileKey - 由 `ledgerFileKey` 统一生成的绝对化文件键
   */
  forget(threadId: string, fileKey: string): void;
}
