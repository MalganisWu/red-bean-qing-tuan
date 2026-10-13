import { mkdir } from "node:fs/promises";
import path from "node:path";

import type { JsonObject, JsonValue } from "../../../protocol/json.js";
import type { Tool, ToolResult, ToolSchema } from "../../definition/tool.js";
import { throwIfReadAborted } from "../read-file/safe-file-reader.js";
import { writeFileAtomically } from "../file-access/atomic-write.js";
import { assertFreshRead } from "../file-access/mutation-guard.js";
import { ledgerFileKey } from "../file-access/ledger-key.js";
import type { FileReadLedger } from "../file-access/port/file-read-ledger.js";

/** 本工具在 Tool Registry 中的注册名；Agent 的 sys_tool_ids 用它引用，改名等于改变对外契约。 */
export const WRITE_FILE_TOOL_NAME = "sys_write_file";

/** 调用方给出的写入目标与内容，已通过运行时校验。 */
export interface WriteFileParams {
  /** 写入目标路径；父目录不存在时由本工具自动创建。 */
  readonly filePath: string;
  /** 写入的完整文件内容，会整体覆盖原有内容，允许为空串。 */
  readonly content: string;
}

/** 工具依赖：账本是必填项，缺失会让「先读后写」闸门失效。 */
export interface WriteFileOptions {
  /** 读取账本，用于确认覆盖既有文件前该文件在本 conversation 读过且未被改动。 */
  readonly ledger: FileReadLedger;
}

/**
 * 构造暴露给模型的 JSON Schema 入参描述。
 *
 * content 允许为空串（用于清空文件），因此不在 Schema 层做最小长度限制；file_path 与 content
 * 都在 `parseWriteFileParams` 里做类型与必填校验。
 *
 * @returns 描述 file_path 与 content 的 JSON Schema 对象
 */
function parameters(): JsonObject {
  return {
    type: "object",
    properties: {
      file_path: {
        type: "string",
        description: "要写入的文件路径；父目录不存在时会自动创建",
      },
      content: {
        type: "string",
        description: "写入的完整文件内容，会整体替换原有内容",
      },
    },
    required: ["file_path", "content"],
  };
}

/**
 * 从 unknown 形状的入参校验并归一化；缺失字段直接失败而不是写入空内容。
 *
 * content 是唯一允许为空串的字段：空内容是合法的清空操作，而 file_path 缺省或为空只意味着
 * 模型没给出目标，二者必须区别对待。
 *
 * @param value - 工具入参原始值，须是含 file_path 与 content 的对象
 * @returns 归一化后的目标路径与写入内容，file_path 已去除首尾空白
 */
function parseWriteFileParams(value: JsonValue): WriteFileParams {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("write_file parameters must be an object");
  }
  const rawPath = value["file_path"];
  if (typeof rawPath !== "string") throw new Error("file_path 必须是字符串");
  const filePath = rawPath.trim();
  if (filePath === "") throw new Error("file_path 不能为空");

  const rawContent = value["content"];
  if (typeof rawContent !== "string") throw new Error("content 必须是字符串");
  return { filePath, content: rawContent };
}

/**
 * 行数按换行符计：结尾换行不额外算一行，与编辑器显示一致。
 *
 * 空内容算 0 行；有内容但无换行算 1 行。这个口径要让工具结果里的行数与模型在编辑器里看到的一致，
 * 否则模型会按错误的行数去定位后续修改。
 *
 * @param content - 已写入或即将写入的完整文件内容
 * @returns 面向显示的行数，空串返回 0
 */
function countLines(content: string): number {
  if (content === "") return 0;
  let breaks = 0;
  for (const character of content) {
    if (character === "\n") breaks += 1;
  }
  return content.endsWith("\n") ? breaks : breaks + 1;
}

/**
 * 新建或整体覆盖文件的无限制工具。
 *
 * 与 `UnrestrictedReadTool` 一样不做路径限制，只在宿主已提供文件系统沙箱时使用。
 * 覆盖既有文件要求当前 conversation 先读过且文件版本未变；新建没有内容可覆盖，因此不要求先读。
 */
export class WriteFileTool implements Tool {
  /** 本工具在 Tool Registry 中的注册名，与 `WRITE_FILE_TOOL_NAME` 保持一致。 */
  public readonly name = WRITE_FILE_TOOL_NAME;
  /** 工具契约：函数名、给模型的说明与 JSON Schema 入参。 */
  public readonly schema: ToolSchema = {
    type: "function",
    function: {
      name: this.name,
      description:
        "写入文件：目标不存在时新建（自动创建父目录），已存在时整体覆盖。覆盖既有文件前必须先用 sys_read_file 读取过该文件，且文件在此之后不能被改动，否则会拒绝写入——局部修改请改用 sys_edit_file。该工具不限制路径，仅应在外部已有文件系统沙箱时使用",
      parameters: parameters(),
    },
  };
  /** 读取账本，是「覆盖前先读」闸门的事实来源；新建路径时经 allowMissing 放行。 */
  readonly #ledger: FileReadLedger;

  public constructor(options: WriteFileOptions) {
    this.#ledger = options.ledger;
  }

  /**
   * 新建或整体覆盖文件。覆盖既有文件前先确认该 conversation 读过且版本未变；写入后作废读取记录。
   *
   * @param value - 工具入参原始值，含 `file_path` 与 `content`，尚未校验
   * @param context - 调用上下文，其 threadId 用于查读取账本
   * @param signal - 取消信号，进入与写入前检查
   * @returns 文本结果，说明写入路径与行数、字节数
   */
  public async execute(
    value: JsonValue,
    context: { readonly threadId: string },
    signal: AbortSignal,
  ): Promise<ToolResult> {
    throwIfReadAborted(signal);
    const params = parseWriteFileParams(value);
    const key = ledgerFileKey(params.filePath);
    await assertFreshRead({
      filePath: params.filePath,
      threadId: context.threadId,
      ledger: this.#ledger,
      allowMissing: true,
    });

    try {
      await mkdir(path.dirname(params.filePath), { recursive: true });
      await writeFileAtomically(params.filePath, params.content);
    } catch (cause: unknown) {
      if (cause instanceof Error) throw cause;
      throw new Error(`写入文件失败: ${String(cause)}`, { cause });
    }

    // 写入改变了文件版本，旧读取记录已不代表模型手里的内容，必须作废以免下一次写入拿到陈旧授权。
    this.#ledger.forget(context.threadId, key);
    const bytes = Buffer.byteLength(params.content, "utf8");
    return {
      content: `已写入 ${params.filePath}（${countLines(params.content)} 行，${bytes} 字节）`,
    };
  }

  /** 无常驻资源需要释放；保留以满足 `Tool` 契约。 */
  public close(): Promise<void> {
    return Promise.resolve();
  }
}
