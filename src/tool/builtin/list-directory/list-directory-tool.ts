import type { Dirent } from "node:fs";
import { readdir, stat } from "node:fs/promises";

import type { JsonObject, JsonValue } from "../../../protocol/json.js";
import type { Tool, ToolResult, ToolSchema } from "../../definition/tool.js";
import { throwIfReadAborted } from "../read-file/safe-file-reader.js";
import { compareByName } from "../file-access/ordering.js";
import { MAX_DIRECTORY_ENTRIES } from "../file-access/limits.js";

/** 本工具在 Tool Registry 中的注册名；Agent 的 sys_tool_ids 用它引用，改名等于改变对外契约。 */
export const LIST_DIRECTORY_TOOL_NAME = "sys_list_directory";

/** 调用方给出的目录路径，已通过运行时校验。 */
export interface ListDirectoryParams {
  /** 已 trim 的目录路径，非空。 */
  readonly dirPath: string;
}

/** 工具实例配置；上限可注入以便测试覆盖截断分支。 */
export interface ListDirectoryOptions {
  /** 输出条目数上限；省略时用 `MAX_DIRECTORY_ENTRIES`。 */
  readonly maxEntries?: number;
}

/**
 * 构造暴露给模型的 JSON Schema 入参：必填的 `path`。
 *
 * @returns 工具注册用的 JSON Schema 对象
 */
function parameters(): JsonObject {
  return {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: "要列举的目录路径，必须是已存在的目录",
      },
    },
    required: ["path"],
  };
}

/**
 * 从 unknown 形状的入参校验并归一化出目录路径；形状不符时抛错而不是猜测。
 *
 * @param value - 工具入参原始值，含 `path` 字段
 * @returns 校验通过的目录路径
 */
function parseListDirectoryParams(value: JsonValue): ListDirectoryParams {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("list_directory 的参数必须是对象");
  }
  const raw = value["path"];
  if (typeof raw !== "string") throw new Error("path 必须是字符串");
  const dirPath = raw.trim();
  if (dirPath === "") throw new Error("path 不能为空");
  return { dirPath };
}

/**
 * 确认目标是目录，把 ENOENT/ENOTDIR 换成调用方能直接理解的中文错误。
 *
 * @param dirPath - 待确认的目录路径，不存在或不是目录时抛错
 */
async function resolveDirectory(dirPath: string): Promise<void> {
  let information;
  try {
    information = await stat(dirPath);
  } catch (cause: unknown) {
    throw new Error(`目录不存在或不可访问: ${dirPath}`, { cause });
  }
  if (!information.isDirectory()) {
    throw new Error(`${JSON.stringify(dirPath)} 不是目录`);
  }
}

/**
 * 读取目录的直接子项。
 *
 * 失败时把底层错误包成带上下文的中文错误，并保留原始 `cause` 便于排查。
 *
 * @param dirPath - 目标目录路径
 * @returns 目录项的 `Dirent` 列表，含文件类型信息
 */
async function readEntries(dirPath: string): Promise<Dirent[]> {
  try {
    return await readdir(dirPath, { withFileTypes: true });
  } catch (cause: unknown) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    throw new Error(`列出目录失败: ${detail}`, { cause });
  }
}

/**
 * 列出目录直接子项的无限制工具。
 *
 * 不递归，不做路径限制：与 `UnrestrictedReadTool` 一样，只在宿主已提供文件系统沙箱时使用。
 * 目录以 `/` 结尾，符号链接按自身类型列出（指向目录的链接不会带 `/`）。
 */
export class ListDirectoryTool implements Tool {
  /** 本工具在 Tool Registry 中的注册名，与 `LIST_DIRECTORY_TOOL_NAME` 保持一致。 */
  public readonly name = LIST_DIRECTORY_TOOL_NAME;
  /** 工具契约：函数名、给模型的说明与 JSON Schema 入参。 */
  public readonly schema: ToolSchema = {
    type: "function",
    function: {
      name: this.name,
      description:
        "列出目录的直接子项（不递归），目录以 / 结尾，按名称排序。用于先确认目录里有什么再决定读哪个文件；按文件名模式查找用 sys_glob，按内容检索用 sys_grep。结果超过上限时会截断并报告总条目数。该工具不限制路径，仅应在外部已有文件系统沙箱时使用",
      parameters: parameters(),
    },
  };
  /** 输出条目数上限；超出部分被截断并附上总条目数。 */
  readonly #maxEntries: number;

  public constructor(options?: ListDirectoryOptions) {
    this.#maxEntries = options?.maxEntries ?? MAX_DIRECTORY_ENTRIES;
  }

  /**
   * 列出目录直接子项。先确认目标是目录，再按名称排序输出，超过上限时截断并报告总条目数。
   *
   * @param value - 工具入参原始值，含 `path` 字段，尚未校验
   * @param _context - 未使用；保留以满足 `Tool` 契约
   * @param signal - 取消信号，读取前后各检查
   * @returns 每行一个条目名的文本结果，目录名以 `/` 结尾
   */
  public async execute(
    value: JsonValue,
    _context: unknown,
    signal: AbortSignal,
  ): Promise<ToolResult> {
    throwIfReadAborted(signal);
    const params = parseListDirectoryParams(value);
    await resolveDirectory(params.dirPath);
    const entries = await readEntries(params.dirPath);
    throwIfReadAborted(signal);

    const names = entries.map((entry: Dirent): string =>
      entry.isDirectory() ? `${entry.name}/` : entry.name,
    );
    names.sort(compareByName);

    if (names.length === 0) return { content: "（空目录）" };

    const shown = names.slice(0, this.#maxEntries);
    if (names.length > shown.length) {
      shown.push(
        `[已截断：目录共 ${names.length} 项，仅显示前 ${shown.length} 项，请缩小范围或改用 sys_glob]`,
      );
    }
    return { content: shown.join("\n") };
  }

  /** 无常驻资源需要释放；保留以满足 `Tool` 契约。 */
  public close(): Promise<void> {
    return Promise.resolve();
  }
}
