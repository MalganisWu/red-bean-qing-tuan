import { constants } from "node:fs";
import { open, realpath, stat, type FileHandle } from "node:fs/promises";
import path from "node:path";

import type { OpenedFile } from "../read-file/safe-file-reader.js";
import type { FileIdentity } from "./model/file-identity.js";

/**
 * 判断 `candidate` 是否落在 `root` 之内（含 root 自身）。
 *
 * 用 `path.relative` 的结果判定而非字符串前缀比较：前缀比较会让 `/data/root-evil` 被误判为
 * 落在 `/data/root` 内。以 `..` 开头或相对化后仍为绝对路径都算越界。
 *
 * @param root - 作为基准的根目录
 * @param candidate - 待判定的路径，通常是已归一化的相对路径或绝对路径
 * @returns candidate 位于 root 之内时为 true，越界时为 false
 */
function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (relative !== ".." &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative))
  );
}

/**
 * 把 `fs.Stats` 上的 `dev` / `ino` 字段映射成本仓统一的 `FileIdentity` 命名。
 *
 * 存在的意义是隔离命名差异：Node 用 `dev` / `ino`，本仓模型用 `device` / `inode`，
 * 只在这一处转换，其余代码不受上游命名影响。
 *
 * @param value - 带 `dev` / `ino` 字段的 stat 结果或其子集
 * @returns 归一化后的设备号与 inode 二元组
 */
function identityOf(value: {
  readonly dev: number;
  readonly ino: number;
}): FileIdentity {
  return { device: value.dev, inode: value.ino };
}

/**
 * 判断两个文件身份是否指向同一个文件对象。
 *
 * 两个字段必须同时相同：仅比较 inode 会在跨设备时把不同文件误判为同一个。
 *
 * @param left - 参与比较的第一个身份
 * @param right - 参与比较的第二个身份
 * @returns 设备号与 inode 均相同时为 true
 */
function sameIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return left.device === right.device && left.inode === right.inode;
}

/**
 * 固定 read root 的文件访问器。Linux 使用已打开目录的 fd，其他平台在打开前后校验
 * realpath 与 inode，避免符号链接和路径替换把读取范围带出沙箱。
 *
 * 为什么分两条实现：**要防的是 TOCTOU**——检查路径合法之后、真正打开之前，
 * 有人把路径上的某一环换成指向外部的符号链接。防御手段的本质都是「让检查与打开作用于同一个对象」：
 * - Linux 走 `/proc/self/fd/<rootfd>/<relative>`，由内核从**已打开的目录 fd** 出发解析，
 *   路径中途被换掉也不影响这次解析，是唯一真正无竞态的做法。
 * - 其他平台没有对等能力，退而求其次：打开前后各做一次 realpath + inode 比对，
 *   把窗口缩到最小并在发现变动时拒绝。
 *
 * root 自身也要校验身份（`assertRootIdentity`）——被托管的目录本身在运行期间被替换，
 * 上面所有相对校验都会建立在错误的基准上。
 */
export class RootedFileAccess {
  /** 根目录的绝对路径，用于把校验通过的相对路径拼回可打开的绝对路径。 */
  readonly #rootPath: string;
  /** 已打开的根目录句柄；Linux 分支直接以它的 fd 作为解析起点。 */
  readonly #rootHandle: FileHandle;
  /** 打开根目录时记录的身份，后续据此检测 root 被替换。 */
  readonly #rootIdentity: FileIdentity;
  /** 是否已关闭；关闭后所有打开操作都必须拒绝，避免使用失效的 fd。 */
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

  /** 释放根目录句柄；重复调用是幂等的，关闭后再打开会失败。 */
  public async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    await this.#rootHandle.close();
  }

  /**
   * 在根目录约束下打开文件，越界访问一律拒绝。
   *
   * @param filePath - 模型给出的路径，相对路径相对 root、绝对路径须落在 root 内
   * @returns 已打开的句柄与其去重键，调用方负责关闭
   */
  public async open(filePath: string): Promise<OpenedFile> {
    if (this.#closed) throw new Error("read root 已关闭");
    const relative = await this.relativePath(filePath);
    return process.platform === "linux"
      ? this.openThroughProc(relative)
      : this.openWithIdentityCheck(relative);
  }

  /**
   * 把入参路径归一成**相对于 root 的路径**，并在这里挡住越界。
   *
   * 两条分支的处理不同：相对路径直接归一化后交给 `isWithin`；
   * 绝对路径要先 `realpath` 解掉符号链接再相对化——否则一个指向外部的软链接
   * 会以「绝对路径」的形式混过相对校验。
   * `isWithin` 判的是 `..` 开头与绝对路径，因此 `../../etc/passwd` 与 `/etc/passwd`
   * 都会在这里被拒。
   *
   * @param filePath - 模型给出的路径，相对路径相对 root、绝对路径须落在 root 内
   * @returns 归一化后相对于 root 的路径，越界时抛出错误而非返回
   */
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

  /**
   * Linux 路径：经由 `/proc/self/fd/<root fd>` 打开。
   * 关键在内核是从**那个已打开的目录**解析相对路径的，因此中途替换符号链接无效。
   * 打开后仍再 realpath 两侧核对一次：fd 复用、挂载点变化这类极端情况仍会被这里拦住。
   *
   * @param relative - 已经过 `relativePath` 校验、相对于 root 的路径
   * @returns 已打开的句柄与其去重键；越界或打开失败时抛出并关闭句柄
   */
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

  /**
   * 非 Linux 的退化实现：三次校验把 TOCTOU 窗口压到最小。
   * 打开前 realpath、打开后同时校验「已打开句柄的 inode」与「路径再次 realpath 的 inode」是否一致——
   * 不一致说明这段时间里路径被换过（`文件路径在打开期间发生变化`），此时宁可拒绝读取。
   *
   * @param relative - 已经过 `relativePath` 校验、相对于 root 的路径
   * @returns 已打开的句柄与其去重键；身份不一致或越界时抛出并关闭句柄
   */
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

  /**
   * 确认 read root 自打开以来没被换掉（device + inode 相同）。
   * 少了这一步，攻击者只要把整个 root 目录改名再放一个同名软链接，
   * 后续所有「相对于 root」的校验都会以一个外部目录为基准。
   */
  private async assertRootIdentity(): Promise<void> {
    const information = await stat(this.#rootPath);
    if (!sameIdentity(this.#rootIdentity, identityOf(information))) {
      throw new Error("read root 在工具运行期间发生变化，已拒绝读取");
    }
  }
}
