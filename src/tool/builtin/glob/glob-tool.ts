import { glob } from "node:fs/promises";

import type { JsonObject, JsonValue } from "../../../protocol/json.js";
import type { Tool, ToolResult, ToolSchema } from "../../definition/tool.js";
import { throwIfReadAborted } from "../read-file/safe-file-reader.js";
import { compareByName } from "../file-access/ordering.js";
import { DEFAULT_DISCOVERY_EXCLUDES } from "../file-access/exclusions.js";
import { MAX_GLOB_RESULTS } from "../file-access/limits.js";

/** 本工具在 Tool Registry 中的注册名；Agent 的 sys_tool_ids 用它引用，改名等于改变对外契约。 */
export const GLOB_TOOL_NAME = "sys_glob";

/** 调用方给出的匹配模式与基准目录，已通过运行时校验。 */
export interface GlobParams {
  readonly pattern: string;
  readonly basePath: string;
}

/** 工具实例配置；上限可注入以便测试覆盖截断分支。 */
export interface GlobOptions {
  readonly maxResults?: number;
}

function parameters(): JsonObject {
  return {
    type: "object",
    properties: {
      pattern: {
        type: "string",
        description:
          "glob 模式，相对基准目录，例如 src/**/*.ts 或 **/*.test.ts",
      },
      path: {
        type: "string",
        description: "匹配的基准目录，省略时使用进程当前工作目录",
      },
    },
    required: ["pattern"],
  };
}

/** 从 unknown 形状的入参校验并归一化出模式与基准目录。 */
function parseGlobParams(value: JsonValue): GlobParams {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("glob parameters must be an object");
  }
  const rawPattern = value["pattern"];
  if (typeof rawPattern !== "string") throw new Error("pattern 必须是字符串");
  const pattern = rawPattern.trim();
  if (pattern === "") throw new Error("pattern 不能为空");

  const rawPath = value["path"];
  if (rawPath !== undefined && typeof rawPath !== "string") {
    throw new Error("path 必须是字符串");
  }
  const basePath = rawPath === undefined ? process.cwd() : rawPath.trim();
  if (basePath === "") throw new Error("path 不能为空");
  return { pattern, basePath };
}

/**
 * 按 glob 模式发现文件的无限制工具。
 *
 * 与 `UnrestrictedReadTool` 一样不做路径限制，只在宿主已提供文件系统沙箱时使用。
 * 结果按路径排序，超过上限时截断并报告匹配总数。
 */
export class GlobTool implements Tool {
  /** 本工具在 Tool Registry 中的注册名，与 `GLOB_TOOL_NAME` 保持一致。 */
  public readonly name = GLOB_TOOL_NAME;
  /** 工具契约：函数名、给模型的说明与 JSON Schema 入参。 */
  public readonly schema: ToolSchema = {
    type: "function",
    function: {
      name: this.name,
      description:
        "按 glob 模式查找文件路径，返回相对基准目录的已排序路径。用于在不知道确切文件名时定位文件；要按内容检索用 sys_grep，要列举某个目录用 sys_list_directory。默认排除 node_modules 与 .git，结果超过上限时会截断并报告匹配总数。该工具不限制路径，仅应在外部已有文件系统沙箱时使用",
      parameters: parameters(),
    },
  };
  readonly #maxResults: number;

  public constructor(options?: GlobOptions) {
    this.#maxResults = options?.maxResults ?? MAX_GLOB_RESULTS;
  }

  /**
   * 执行 glob 匹配。先收集全部结果再排序，仅在输出阶段按上限截断，
   * 截断时附上真实匹配总数供调用方判断是否需缩小范围。
   *
   * @param value - 工具入参原始值，含 `pattern` 与可选 `path`，尚未校验
   * @param _context - 未使用；保留以满足 `Tool` 契约
   * @param signal - 取消信号，枚举过程中逐项检查
   * @returns 每行一个相对路径的文本结果，或「无匹配」提示
   */
  public async execute(
    value: JsonValue,
    _context: unknown,
    signal: AbortSignal,
  ): Promise<ToolResult> {
    throwIfReadAborted(signal);
    const params = parseGlobParams(value);
    const matches = await this.#collect(params, signal);

    if (matches.length === 0) {
      return {
        content: `没有匹配 ${params.pattern} 的路径（基准目录 ${params.basePath}，已排除 node_modules 与 .git）`,
      };
    }

    matches.sort(compareByName);
    const shown = matches.slice(0, this.#maxResults);
    if (matches.length > shown.length) {
      shown.push(
        `[已截断：共 ${matches.length} 个匹配，仅显示前 ${shown.length} 个，请缩小模式范围]`,
      );
    }
    return { content: shown.join("\n") };
  }

  /**
   * 收集全部匹配后再截断输出。
   *
   * 上限保护的是模型上下文，不是枚举本身：`fs.glob` 本来就要走完整棵树，因此这里保留精确的匹配
   * 总数，让调用方能据此判断是否需要缩小范围。截断只发生在输出阶段。
   */
  async #collect(params: GlobParams, signal: AbortSignal): Promise<string[]> {
    const matches: string[] = [];
    try {
      const iterator = glob(params.pattern, {
        cwd: params.basePath,
        exclude: DEFAULT_DISCOVERY_EXCLUDES,
      });
      for await (const entry of iterator) {
        throwIfReadAborted(signal);
        matches.push(entry);
      }
    } catch (cause: unknown) {
      if (signal.aborted) throw cause;
      const detail = cause instanceof Error ? cause.message : String(cause);
      throw new Error(`模式匹配失败: ${detail}`, { cause });
    }
    return matches;
  }

  /** 无常驻资源需要释放；保留以满足 `Tool` 契约。 */
  public close(): Promise<void> {
    return Promise.resolve();
  }
}
