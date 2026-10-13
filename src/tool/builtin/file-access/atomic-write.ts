import { randomUUID } from "node:crypto";
import { open, rename, rm, stat, type FileHandle } from "node:fs/promises";
import path from "node:path";

/**
 * 原子写入：同目录临时文件 → 写入 → fsync → rename 覆盖。
 *
 * 直接对目标文件写入会在中途失败时留下半写文件，对于「模型正基于这份内容做下一步判断」的场景，
 * 半写文件比写入失败更有害。因此新内容先落到同目录（保证 rename 不跨文件系统），通过 `fsync`
 * 落盘后再用一次 `rename` 原子替换目标；任何失败点都清理临时文件并保持原文件不变。
 *
 * 覆盖既有文件时保留其权限位，避免把可执行脚本改写成普通文件。
 *
 * @param targetPath - 目标文件路径，父目录必须已存在
 * @param content - 要写入的完整内容，整体替换原文件
 */
export async function writeFileAtomically(
  targetPath: string,
  content: string,
): Promise<void> {
  const directory = path.dirname(targetPath);
  const temporary = path.join(
    directory,
    `.${path.basename(targetPath)}.${randomUUID()}.tmp`,
  );
  const mode = await existingPermissionBits(targetPath);
  let handle: FileHandle | undefined;
  try {
    handle = await open(temporary, "wx", mode);
    await handle.writeFile(content, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporary, targetPath);
  } catch (cause: unknown) {
    if (handle !== undefined) await closeQuietly(handle);
    await removeQuietly(temporary);
    const detail = cause instanceof Error ? cause.message : String(cause);
    throw new Error(`写入文件失败: ${detail}`, { cause });
  }
}

/**
 * 新建目标没有权限位可继承，返回 undefined 交给系统默认值与 umask 决定。
 *
 * @param targetPath - 目标文件路径，仅用于探测其既有权限位
 * @returns 既有文件的权限位；文件不存在或无法 stat 时返回 undefined
 */
async function existingPermissionBits(
  targetPath: string,
): Promise<number | undefined> {
  try {
    const information = await stat(targetPath);
    return information.mode & 0o7777;
  } catch {
    return undefined;
  }
}

/**
 * 清理阶段的失败不得覆盖原始错误，因此只吞掉清理异常。
 *
 * @param handle - 需要关闭的文件句柄，重复关闭或已失效时不抛出
 */
async function closeQuietly(handle: FileHandle): Promise<void> {
  try {
    await handle.close();
  } catch {
    return;
  }
}

/**
 * 尽力删除临时文件，同样吞掉清理异常，避免掩盖触发回滚的原始错误。
 *
 * @param target - 待删除的临时文件路径，不存在时也被视为清理完成
 */
async function removeQuietly(target: string): Promise<void> {
  try {
    await rm(target, { force: true });
  } catch {
    return;
  }
}
