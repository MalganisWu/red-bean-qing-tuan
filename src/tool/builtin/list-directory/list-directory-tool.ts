import type { Dirent } from "node:fs";
import { readdir, stat } from "node:fs/promises";

import type { JsonObject, JsonValue } from "../../../protocol/json.js";
import type { Tool, ToolResult, ToolSchema } from "../../definition/tool.js";
import { throwIfReadAborted } from "../read-file/safe-file-reader.js";
import { compareByName } from "../file-access/ordering.js";
import { MAX_DIRECTORY_ENTRIES } from "../file-access/limits.js";

export const LIST_DIRECTORY_TOOL_NAME = "sys_list_directory";

/** 调用方给出的目录路径，已通过运行时校验。 */
export interface ListDirectoryParams {
  readonly dirPath: string;
}

/** 工具实例配置；上限可注入以便测试覆盖截断分支。 */
export interface ListDirectoryOptions {
  readonly maxEntries?: number;
}

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

/** 从 unknown 形状的入参校验并归一化出目录路径；形状不符时抛错而不是猜测。 */
function parseListDirectoryParams(value: JsonValue): ListDirectoryParams {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("list_directory parameters must be an object");
  }
  const raw = value["path"];
  if (typeof raw !== "string") throw new Error("path 必须是字符串");
  const dirPath = raw.trim();
  if (dirPath === "") throw new Error("path 不能为空");
  return { dirPath };
}

/** 确认目标是目录，把 ENOENT/ENOTDIR 换成调用方能直接理解的中文错误。 */
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
  public readonly name = LIST_DIRECTORY_TOOL_NAME;
  public readonly schema: ToolSchema = {
    type: "function",
    function: {
      name: this.name,
      description:
        "列出目录的直接子项（不递归），目录以 / 结尾，按名称排序。用于先确认目录里有什么再决定读哪个文件；按文件名模式查找用 sys_glob，按内容检索用 sys_grep。结果超过上限时会截断并报告总条目数。该工具不限制路径，仅应在外部已有文件系统沙箱时使用",
      parameters: parameters(),
    },
  };
  readonly #maxEntries: number;

  public constructor(options?: ListDirectoryOptions) {
    this.#maxEntries = options?.maxEntries ?? MAX_DIRECTORY_ENTRIES;
  }

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

  public close(): Promise<void> {
    return Promise.resolve();
  }
}
