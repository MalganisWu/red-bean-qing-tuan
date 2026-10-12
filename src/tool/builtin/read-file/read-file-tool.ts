import { constants } from "node:fs";
import { open, realpath, stat, type FileHandle } from "node:fs/promises";
import path from "node:path";

import type { ToolCallContext } from "../../../protocol/run-identity.js";
import type { JsonObject, JsonValue } from "../../../protocol/json.js";
import type { Tool, ToolResult, ToolSchema } from "../../definition/tool.js";
import { RootedFileAccess } from "../file-access/path-policy.js";
import type { FileIdentity } from "../file-access/model/file-identity.js";
import type { FileReadLedger } from "../file-access/port/file-read-ledger.js";
import { MemoryFileReadLedger } from "../file-access/read-ledger.js";
import { ledgerFileKey } from "../file-access/ledger-key.js";
import {
  FILE_UNCHANGED_STUB,
  MAX_READ_SIZE_BYTES,
  MAX_READ_TOKENS,
  parseReadFileParams,
  readNumberedLines,
  roughTokenCount,
  throwIfReadAborted,
  type OpenedFile,
  type ReadLinesResult,
} from "./safe-file-reader.js";

export {
  FILE_UNCHANGED_STUB,
  MAX_LINES_TO_READ,
  MAX_READ_SIZE_BYTES,
  MAX_READ_TOKENS,
} from "./safe-file-reader.js";

/** 本工具在 Tool Registry 中的注册名；Agent 的 sys_tool_ids 用它引用，改名等于改变对外契约。 */
export const READ_FILE_TOOL_NAME = "sys_read_file";

function parameters(rooted: boolean): JsonObject {
  return {
    type: "object",
    properties: {
      file_path: {
        type: "string",
        description: rooted
          ? "文件路径；相对路径以沙箱根目录为基准，绝对路径必须位于根目录内"
          : "要读取的文件的绝对路径",
      },
      offset: { type: "integer", description: "起始行号（从 1 开始）" },
      limit: { type: "integer", description: "读取行数，默认最多 2000 行" },
    },
    required: ["file_path"],
  };
}

/** 无路径限制的读取工具，只能在宿主已经提供文件系统沙箱时使用。 */
export class UnrestrictedReadTool implements Tool {
  public readonly name = READ_FILE_TOOL_NAME;
  public readonly schema: ToolSchema = {
    type: "function",
    function: {
      name: this.name,
      description:
        "从本地磁盘读取文件（默认读前 2000 行，cat -n 格式带行号）。大文件需用 offset/limit 分片；单次输出受 25k token / 256KB 限制。该工具不限制路径，仅应在外部已有文件系统沙箱时使用",
      parameters: parameters(false),
    },
  };
  readonly #ledger: FileReadLedger;

  /**
   * 账本可选：未注入时自建进程内实例，保持既有的无参构造可用。
   * 写入类工具依赖同一账本实现「先读后写」，宿主需要共享时应在 composition root 显式创建并传入。
   */
  public constructor(ledger?: FileReadLedger) {
    this.#ledger = ledger ?? new MemoryFileReadLedger();
  }

  public async execute(
    value: JsonValue,
    context: ToolCallContext,
    signal: AbortSignal,
  ): Promise<ToolResult> {
    throwIfReadAborted(signal);
    const params = parseReadFileParams(value);
    const opened = await this.openFile(params.filePath);
    try {
      const information = await opened.handle.stat();
      if (information.isDirectory()) {
        throw new Error(`${JSON.stringify(params.filePath)} 是目录`);
      }
      if (!params.ranged && information.size > MAX_READ_SIZE_BYTES) {
        throw new Error(
          `文件大小 ${information.size} 字节超过上限 ${MAX_READ_SIZE_BYTES}，请用 offset/limit 分片读取或搜索特定内容`,
        );
      }
      // 展示层沿用秒级时间戳；账本记录毫秒值，写入类工具需要比展示更细的版本粒度。
      const mtime = Math.floor(information.mtimeMs / 1_000);
      const previous = this.#ledger.read(
        context.threadId,
        ledgerFileKey(params.filePath),
      );
      if (
        previous?.mtimeMs === information.mtimeMs &&
        previous.offset === params.offset &&
        previous.limit === params.limit
      ) {
        return { content: FILE_UNCHANGED_STUB };
      }

      const source = await opened.handle.readFile({ encoding: "utf8", signal });
      const result = readNumberedLines(
        source,
        params.offset,
        params.limit,
        signal,
      );
      const tokens = roughTokenCount(result.content);
      if (tokens > MAX_READ_TOKENS) {
        throw new Error(
          `文件内容（约 ${tokens} token）超过上限 ${MAX_READ_TOKENS}，请用 offset/limit 读取特定行段或搜索特定内容`,
        );
      }
      this.#ledger.record(context.threadId, ledgerFileKey(params.filePath), {
        mtimeMs: information.mtimeMs,
        offset: params.offset,
        limit: params.limit,
        identity: { device: information.dev, inode: information.ino },
      });
      const content = this.withContinuation(
        result,
        params.filePath,
        params.offset,
        params.limit,
      );
      /** 重新取回被引用的行段；取回后作废旧记录，避免写入闸门放行模型手里的过期版本。 */
      const fetchPreservedContent = async (
        fetchSignal: AbortSignal,
      ): Promise<Uint8Array> => {
        const restored = await this.readFileLines(
          params.filePath,
          params.offset,
          params.limit,
          fetchSignal,
        );
        this.#ledger.forget(context.threadId, ledgerFileKey(params.filePath));
        return new TextEncoder().encode(restored.content);
      };
      return {
        content,
        preserve: {
          kind: "file",
          key: opened.key,
          timestamp: mtime,
          fetch: fetchPreservedContent,
        },
      };
    } catch (cause: unknown) {
      const detail = cause instanceof Error ? cause.message : String(cause);
      throw new Error(`读取文件失败: ${detail}`, { cause });
    } finally {
      await opened.handle.close();
    }
  }

  public close(): Promise<void> {
    return Promise.resolve();
  }

  protected async openFile(filePath: string): Promise<OpenedFile> {
    return { handle: await open(filePath, constants.O_RDONLY), key: filePath };
  }

  private withContinuation(
    result: ReadLinesResult,
    filePath: string,
    offset: number,
    limit: number,
  ): string {
    if (offset + limit - 1 >= result.totalLines) return result.content;
    return `${result.content}\n[共 ${result.totalLines} 行，当前读到 ${offset + limit - 1} 行，后续用 Read(file_path=${JSON.stringify(filePath)}, offset=${offset + limit}) 继续]`;
  }

  private async readFileLines(
    filePath: string,
    offset: number,
    limit: number,
    signal: AbortSignal,
  ): Promise<ReadLinesResult> {
    throwIfReadAborted(signal);
    const opened = await this.openFile(filePath);
    try {
      const source = await opened.handle.readFile({ encoding: "utf8", signal });
      return readNumberedLines(source, offset, limit, signal);
    } finally {
      await opened.handle.close();
    }
  }
}

/** 默认 fail-closed：所有路径解析与打开均委托给固定根目录访问器。 */
export class RootedReadTool extends UnrestrictedReadTool implements Tool {
  public override readonly schema: ToolSchema = {
    type: "function",
    function: {
      name: this.name,
      description:
        "从沙箱根目录内读取文件；路径穿越和根目录外符号链接会被拒绝，支持 offset/limit 分片",
      parameters: parameters(true),
    },
  };
  readonly #access: RootedFileAccess;

  public constructor(
    rootPath: string,
    rootHandle: FileHandle,
    rootIdentity: FileIdentity,
    ledger?: FileReadLedger,
  ) {
    super(ledger);
    this.#access = new RootedFileAccess(rootPath, rootHandle, rootIdentity);
  }

  public override close(): Promise<void> {
    return this.#access.close();
  }

  protected override openFile(filePath: string): Promise<OpenedFile> {
    return this.#access.open(filePath);
  }
}

export async function createRootedReadTool(
  root: string,
  ledger?: FileReadLedger,
): Promise<RootedReadTool> {
  if (root.trim().length === 0) throw new Error("read root 不能为空");
  const rootPath = await realpath(path.resolve(root));
  const information = await stat(rootPath);
  if (!information.isDirectory()) {
    throw new Error(`read root ${JSON.stringify(root)} 不是目录`);
  }
  const rootHandle = await open(rootPath, constants.O_RDONLY);
  return new RootedReadTool(
    rootPath,
    rootHandle,
    {
      device: information.dev,
      inode: information.ino,
    },
    ledger,
  );
}
