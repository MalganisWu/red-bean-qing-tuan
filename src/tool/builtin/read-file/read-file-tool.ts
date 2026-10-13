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

/**
 * 生成暴露给模型的 JSON Schema 入参描述。
 *
 * `rooted` 决定 `file_path` 的语义说明：受限工具强调相对路径以沙箱根目录为基准、
 * 绝对路径必须落在根内，不受限工具则要求绝对路径。两种形态的字段集合一致，仅描述不同。
 *
 * @param rooted - 是否为根目录受限形态，取 true 时描述沙箱内的路径规则
 * @returns 描述读取工具入参的 JSON Schema 对象
 */
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
  /** 本工具在 Tool Registry 中的注册名，与 `READ_FILE_TOOL_NAME` 保持一致。 */
  public readonly name = READ_FILE_TOOL_NAME;
  /** 工具契约：函数名、给模型的说明与 JSON Schema 入参。 */
  public readonly schema: ToolSchema = {
    type: "function",
    function: {
      name: this.name,
      description:
        "从本地磁盘读取文件（默认读前 2000 行，cat -n 格式带行号）。大文件需用 offset/limit 分片；单次输出受 25k token / 256KB 限制。该工具不限制路径，仅应在外部已有文件系统沙箱时使用",
      parameters: parameters(false),
    },
  };
  /** 读取账本，按线程记录最近一次读取的范围与文件版本，供写入类工具做「先读后写」校验。 */
  readonly #ledger: FileReadLedger;

  /**
   * 账本可选：未注入时自建进程内实例，保持既有的无参构造可用。
   * 写入类工具依赖同一账本实现「先读后写」，宿主需要共享时应在 composition root 显式创建并传入。
   */
  public constructor(ledger?: FileReadLedger) {
    this.#ledger = ledger ?? new MemoryFileReadLedger();
  }

  /**
   * 读取文件并加行号返回。先查账本：内容与范围都与上次读取一致时只回占位文案；
   * 目录、超限文件与超量 token 会被拒绝。记录本次读取供写入类工具做版本比对，
   * 并附带一个可重取被引用行段的 `preserve` 句柄。
   *
   * @param value - 工具入参原始值，含 `file_path` 及可选 `offset`/`limit`，尚未校验
   * @param context - 调用上下文，其 threadId 决定读取账本的归属
   * @param signal - 取消信号，读取与分片时传递
   * @returns 带行号的内容文本，或「文件未变」占位文案
   */
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

  /** 无常驻资源需要释放；保留以满足 `Tool` 契约。 */
  public close(): Promise<void> {
    return Promise.resolve();
  }

  /**
   * 打开目标文件供读取。基类不做路径限制；子类覆写以接入根目录约束。
   *
   * @param filePath - 模型给出的路径，使用前未做任何沙箱校验
   * @returns 已打开的句柄与其去重键，调用方负责关闭
   */
  protected async openFile(filePath: string): Promise<OpenedFile> {
    return { handle: await open(filePath, constants.O_RDONLY), key: filePath };
  }

  /**
   * 在内容片段未覆盖全文时追加续读提示。
   *
   * 提示里直接带出下一次可用的 offset，让模型接着读而不是重新猜范围；
   * 若本次已读到最后一行，则原样返回内容，不添加任何多余噪音。
   *
   * @param result - 本次分片读取的带行号内容与文件真实总行数
   * @param filePath - 被读取的路径，用于拼出可直接复制执行的续读调用示例
   * @param offset - 本次起始行号，从 1 开始
   * @param limit - 本次读取的行数上限
   * @returns 可能追加了续读提示的内容文本
   */
  private withContinuation(
    result: ReadLinesResult,
    filePath: string,
    offset: number,
    limit: number,
  ): string {
    if (offset + limit - 1 >= result.totalLines) return result.content;
    return `${result.content}\n[共 ${result.totalLines} 行，当前读到 ${offset + limit - 1} 行，后续用 Read(file_path=${JSON.stringify(filePath)}, offset=${offset + limit}) 继续]`;
  }

  /**
   * 直接读取文件全文并切出指定行区间，供 `preserve` 句柄重取被引用行段时使用。
   *
   * 与 `execute` 的关键区别：这里不查账本、不做「文件未变」短路、也不记录本次读取，
   * 因为调用方要的正是当前磁盘上的内容，而非账本里的历史版本。
   *
   * @param filePath - 要读取的路径，受限子类会在此施加根目录校验
   * @param offset - 起始行号，从 1 开始
   * @param limit - 最多读取的行数
   * @param signal - 取消信号，读取与分片时传递
   * @returns 带行号的内容片段与文件真实总行数
   */
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
  /** 工具契约：覆写说明与入参描述以反映根目录约束下的路径语义。 */
  public override readonly schema: ToolSchema = {
    type: "function",
    function: {
      name: this.name,
      description:
        "从沙箱根目录内读取文件；路径穿越和根目录外符号链接会被拒绝，支持 offset/limit 分片",
      parameters: parameters(true),
    },
  };
  /** 固定根目录的文件访问器；所有路径解析与打开都经它施加根约束。 */
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

  /** 释放根目录句柄；工具实例因此不可再用。 */
  public override close(): Promise<void> {
    return this.#access.close();
  }

  /**
   * 经根目录访问器打开文件，路径穿越与根外符号链接在此被拒绝。
   *
   * @param filePath - 模型给出的路径，相对路径以沙箱根目录为基准
   * @returns 已打开的句柄与其去重键，调用方负责关闭
   */
  protected override openFile(filePath: string): Promise<OpenedFile> {
    return this.#access.open(filePath);
  }
}

/**
 * 解析根目录并建立固定的根句柄，组装出 fail-closed 的读取工具。
 *
 * 启动即 `realpath` 归一化根目录并校验其为目录，使后续所有访问都以同一句柄为锚点；
 * 根目录不存在或不是目录时直接失败，不留半可用状态。
 *
 * @param root - 沙箱根目录，接受相对路径，会解析为其真实路径
 * @param ledger - 可选的共享读取账本；省略时工具自建进程内实例
 * @returns 已绑定根目录的读取工具实例
 */
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
