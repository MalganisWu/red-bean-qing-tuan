import { constants } from "node:fs";
import { open, realpath, stat, type FileHandle } from "node:fs/promises";
import path from "node:path";

import type { OpenedFile } from "../read-file/safe-file-reader.js";
import type { FileIdentity } from "./model/file-identity.js";

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (relative !== ".." &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative))
  );
}

function identityOf(value: {
  readonly dev: number;
  readonly ino: number;
}): FileIdentity {
  return { device: value.dev, inode: value.ino };
}

function sameIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return left.device === right.device && left.inode === right.inode;
}

/**
 * 固定 read root 的文件访问器。Linux 使用已打开目录的 fd，其他平台在打开前后校验
 * realpath 与 inode，避免符号链接和路径替换把读取范围带出沙箱。
 */
export class RootedFileAccess {
  readonly #rootPath: string;
  readonly #rootHandle: FileHandle;
  readonly #rootIdentity: FileIdentity;
  #closed = false;

  public constructor(
    rootPath: string,
    rootHandle: FileHandle,
    rootIdentity: FileIdentity,
  ) {
    this.#rootPath = rootPath;
    this.#rootHandle = rootHandle;
    this.#rootIdentity = rootIdentity;
  }

  public async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    await this.#rootHandle.close();
  }

  public async open(filePath: string): Promise<OpenedFile> {
    if (this.#closed) throw new Error("read root 已关闭");
    const relative = await this.relativePath(filePath);
    return process.platform === "linux"
      ? this.openThroughProc(relative)
      : this.openWithIdentityCheck(relative);
  }

  private async relativePath(filePath: string): Promise<string> {
    const cleaned = path.normalize(filePath);
    let relative = cleaned;
    if (path.isAbsolute(cleaned)) {
      const resolved = await realpath(cleaned);
      relative = path.relative(this.#rootPath, resolved);
    }
    if (!isWithin(".", relative) || path.isAbsolute(relative)) {
      throw new Error(`路径 ${JSON.stringify(filePath)} 超出 read root`);
    }
    return relative;
  }

  private async openThroughProc(relative: string): Promise<OpenedFile> {
    const rootDescriptorPath = `/proc/self/fd/${this.#rootHandle.fd}`;
    const handle = await open(
      path.join(rootDescriptorPath, relative),
      constants.O_RDONLY,
    );
    try {
      const [currentRoot, openedPath] = await Promise.all([
        realpath(rootDescriptorPath),
        realpath(`/proc/self/fd/${handle.fd}`),
      ]);
      if (!isWithin(currentRoot, openedPath)) {
        throw new Error("路径不在 read root 内或不可读取");
      }
      return { handle, key: path.join(this.#rootPath, relative) };
    } catch (cause: unknown) {
      await handle.close();
      throw cause;
    }
  }

  private async openWithIdentityCheck(relative: string): Promise<OpenedFile> {
    await this.assertRootIdentity();
    const candidate = path.join(this.#rootPath, relative);
    const resolvedBeforeOpen = await realpath(candidate);
    if (!isWithin(this.#rootPath, resolvedBeforeOpen)) {
      throw new Error("路径不在 read root 内或不可读取");
    }
    const handle = await open(resolvedBeforeOpen, constants.O_RDONLY);
    try {
      const [openedInformation, resolvedAfterOpen] = await Promise.all([
        handle.stat(),
        realpath(candidate),
        this.assertRootIdentity(),
      ]);
      if (!isWithin(this.#rootPath, resolvedAfterOpen)) {
        throw new Error("路径不在 read root 内或不可读取");
      }
      const currentInformation = await stat(resolvedAfterOpen);
      if (
        !sameIdentity(
          identityOf(openedInformation),
          identityOf(currentInformation),
        )
      ) {
        throw new Error("文件路径在打开期间发生变化，已拒绝读取");
      }
      return { handle, key: path.join(this.#rootPath, relative) };
    } catch (cause: unknown) {
      await handle.close();
      throw cause;
    }
  }

  private async assertRootIdentity(): Promise<void> {
    const information = await stat(this.#rootPath);
    if (!sameIdentity(this.#rootIdentity, identityOf(information))) {
      throw new Error("read root 在工具运行期间发生变化，已拒绝读取");
    }
  }
}
