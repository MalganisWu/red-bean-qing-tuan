import { stat } from "node:fs/promises";

import { ledgerFileKey } from "./ledger-key.js";
import type { FileReadLedger } from "./port/file-read-ledger.js";

/** 写入类工具的版本闸门参数。 */
export interface FreshReadCheck {
  /** 待写入的目标路径，同时也是向账本查询读取记录的键来源。 */
  readonly filePath: string;
  /** conversation 标识，用于把读取记录隔离到发起写入的会话。 */
  readonly threadId: string;
  /** 读取工具写入、写入工具查询的同一份账本实例，缺失记录即视为未读过。 */
  readonly ledger: FileReadLedger;
  /** 目标不存在时是否放行。新建为 true；修改既有内容为 false。 */
  readonly allowMissing: boolean;
}

/**
 * 版本闸门：要求当前 conversation 已读过该文件，且文件自读取以来未被改动。
 *
 * 目的不是流程仪式，而是保证模型手里的内容与磁盘一致——它基于这份内容做出的替换判断才不会覆盖掉
 * 别人（或另一个会话）在此期间写入的改动。任何一项无法确认都 fail-closed。
 *
 * 新建场景（`allowMissing`）没有内容可覆盖，因此不要求先读。
 *
 * @param check - 目标路径、conversation 标识、账本与「允许目标缺失」开关
 */
export async function assertFreshRead(check: FreshReadCheck): Promise<void> {
  const key = ledgerFileKey(check.filePath);
  let information;
  try {
    information = await stat(check.filePath);
  } catch (cause: unknown) {
    if (check.allowMissing) return;
    throw new Error(`文件不存在或不可访问: ${check.filePath}`, { cause });
  }
  if (!information.isFile()) {
    throw new Error(`${JSON.stringify(check.filePath)} 不是普通文件，拒绝写入`);
  }
  const record = check.ledger.read(check.threadId, key);
  if (record === undefined) {
    throw new Error(`修改已存在的文件前必须先读取: ${check.filePath}`);
  }
  /*
   * 用 mtime 判「有没有变过」。这是个**启发式**，边界要说清楚：
   * 某些文件系统（尤其部分容器叠加层与老式 FS）的 mtime 粒度较粗，
   * 同一时间片内先读后改再写，两次 mtime 可能相等，闸门漏过。
   * 要更严的宿主应当提供带内容哈希的 FileReadLedger 实现——
   * 契约由 `port/file-read-ledger.ts` 定义，这里只依赖它返回的记录。
   */
  if (record.mtimeMs !== information.mtimeMs) {
    throw new Error(
      `文件在读取后已发生变化，请重新读取再写入: ${check.filePath}`,
    );
  }
}
