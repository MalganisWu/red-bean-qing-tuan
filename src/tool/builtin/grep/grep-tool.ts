import { glob, readFile, stat } from "node:fs/promises";
import path from "node:path";

import type { JsonObject, JsonValue } from "../../../protocol/json.js";
import type { Tool, ToolResult, ToolSchema } from "../../definition/tool.js";
import { throwIfReadAborted } from "../read-file/safe-file-reader.js";
import { compareByName } from "../file-access/ordering.js";
import { DEFAULT_DISCOVERY_EXCLUDES } from "../file-access/exclusions.js";
import {
  MAX_GREP_FILE_BYTES,
  MAX_GREP_LINE_CHARS,
  MAX_GREP_MATCHES,
} from "../file-access/limits.js";

/** 本工具在 Tool Registry 中的注册名；Agent 的 sys_tool_ids 用它引用，改名等于改变对外契约。 */
export const GREP_TOOL_NAME = "sys_grep";

/**
 * 计数上限相对输出上限的倍数。
 *
 * 输出上限保护模型上下文，计数上限保护进程：命中极多的模式（例如单字符）在整仓上可能有几十万处，
 * 无限计数会把「检索」变成一次全量扫描。超过该倍数后停止计数并只报告「超过」，因为对调用方而言
 * 「多到需要缩小范围」这一结论已经足够。
 */
const COUNT_CEILING_FACTOR = 10;

/** 判定二进制时检查的文件头字节数。 */
const BINARY_SNIFF_BYTES = 8_192;

/** 调用方给出的检索条件，已通过运行时校验。 */
export interface GrepParams {
  readonly regex: RegExp;
  readonly basePath: string;
  readonly include: string;
}

/** 工具实例配置；上限可注入以便测试覆盖截断分支。 */
export interface GrepOptions {
  readonly maxMatches?: number;
}

function parameters(): JsonObject {
  return {
    type: "object",
    properties: {
      pattern: {
        type: "string",
        description: "要检索的正则表达式，按行匹配",
      },
      path: {
        type: "string",
        description: "检索的基准目录，省略时使用进程当前工作目录",
      },
      include: {
        type: "string",
        description:
          "限定参与检索的文件 glob 模式，省略时为 **/*；例如 **/*.ts",
      },
    },
    required: ["pattern"],
  };
}

/** 从 unknown 形状的入参校验并归一化；正则非法与字段缺失都在此阶段失败。 */
function parseGrepParams(value: JsonValue): GrepParams {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("grep parameters must be an object");
  }
  const rawPattern = value["pattern"];
  if (typeof rawPattern !== "string") throw new Error("pattern 必须是字符串");
  if (rawPattern === "") throw new Error("pattern 不能为空");

  let regex: RegExp;
  try {
    regex = new RegExp(rawPattern);
  } catch (cause: unknown) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    throw new Error(`正则表达式无效: ${detail}`, { cause });
  }

  const rawPath = value["path"];
  if (rawPath !== undefined && typeof rawPath !== "string") {
    throw new Error("path 必须是字符串");
  }
  const basePath = rawPath === undefined ? process.cwd() : rawPath.trim();
  if (basePath === "") throw new Error("path 不能为空");

  const rawInclude = value["include"];
  if (rawInclude !== undefined && typeof rawInclude !== "string") {
    throw new Error("include 必须是字符串");
  }
  const include = rawInclude === undefined ? "**/*" : rawInclude.trim();
  if (include === "") throw new Error("include 不能为空");

  return { regex, basePath, include };
}

/** 含 NUL 的文件视为二进制：对其按行匹配只会把乱码塞进模型上下文。 */
function looksBinary(buffer: Buffer): boolean {
  const limit = Math.min(buffer.byteLength, BINARY_SNIFF_BYTES);
  for (let index = 0; index < limit; index += 1) {
    if (buffer[index] === 0) return true;
  }
  return false;
}

/** 单行命中结果，附带被跳过文件的统计，避免静默丢弃。 */
interface GrepAccumulator {
  readonly lines: string[];
  total: number;
  skippedLarge: number;
  skippedBinary: number;
  ceilingReached: boolean;
}

/**
 * 按内容检索文件的无限制工具。
 *
 * 与 `UnrestrictedReadTool` 一样不做路径限制，只在宿主已提供文件系统沙箱时使用。
 * 结果格式为 `相对路径:行号: 行内容`，按路径与行号排序；被跳过的大文件与二进制文件会明确计数。
 */
export class GrepTool implements Tool {
  public readonly name = GREP_TOOL_NAME;
  public readonly schema: ToolSchema = {
    type: "function",
    function: {
      name: this.name,
      description:
        "在目录内按正则检索文件内容，返回 `路径:行号: 内容` 形式的匹配行。用于在不知道目标在哪个文件时定位代码或配置；已知文件名时用 sys_glob，只需列举目录用 sys_list_directory。默认检索全部文本文件并排除 node_modules 与 .git，二进制与超大文件会被跳过并计数。该工具不限制路径，仅应在外部已有文件系统沙箱时使用",
      parameters: parameters(),
    },
  };
  readonly #maxMatches: number;

  public constructor(options?: GrepOptions) {
    this.#maxMatches = options?.maxMatches ?? MAX_GREP_MATCHES;
  }

  public async execute(
    value: JsonValue,
    _context: unknown,
    signal: AbortSignal,
  ): Promise<ToolResult> {
    throwIfReadAborted(signal);
    const params = parseGrepParams(value);
    const accumulator = await this.#scan(params, signal);

    if (accumulator.total === 0) {
      return {
        content: `没有匹配 ${params.regex.source} 的内容（基准目录 ${params.basePath}，文件模式 ${params.include}，已排除 node_modules 与 .git）`,
      };
    }

    const output = [...accumulator.lines];
    if (accumulator.total > accumulator.lines.length) {
      const scope = accumulator.ceilingReached
        ? `匹配数超过 ${accumulator.total} 处`
        : `共 ${accumulator.total} 处匹配`;
      output.push(
        `[已截断：${scope}，仅显示前 ${accumulator.lines.length} 处，请缩小模式范围]`,
      );
    }
    if (accumulator.skippedBinary > 0) {
      output.push(`[已跳过 ${accumulator.skippedBinary} 个二进制文件]`);
    }
    if (accumulator.skippedLarge > 0) {
      output.push(
        `[已跳过 ${accumulator.skippedLarge} 个超过 ${MAX_GREP_FILE_BYTES} 字节的文件]`,
      );
    }
    return { content: output.join("\n") };
  }

  /** 遍历候选文件并累积命中；达到计数上限即停止，避免把检索退化为全量扫描。 */
  async #scan(
    params: GrepParams,
    signal: AbortSignal,
  ): Promise<GrepAccumulator> {
    const accumulator: GrepAccumulator = {
      lines: [],
      total: 0,
      skippedLarge: 0,
      skippedBinary: 0,
      ceilingReached: false,
    };
    const ceiling = this.#maxMatches * COUNT_CEILING_FACTOR;
    const candidates = await this.#candidateFiles(params, signal);
    candidates.sort(compareByName);

    for (const relative of candidates) {
      throwIfReadAborted(signal);
      const fullPath = path.join(params.basePath, relative);
      const information = await stat(fullPath);
      if (!information.isFile()) continue;
      if (information.size > MAX_GREP_FILE_BYTES) {
        accumulator.skippedLarge += 1;
        continue;
      }
      const buffer = await readFile(fullPath);
      if (looksBinary(buffer)) {
        accumulator.skippedBinary += 1;
        continue;
      }
      const hit = this.#matchFile(
        relative,
        buffer.toString("utf8"),
        params.regex,
        accumulator,
        ceiling,
      );
      if (hit) {
        accumulator.ceilingReached = true;
        break;
      }
    }
    return accumulator;
  }

  async #candidateFiles(
    params: GrepParams,
    signal: AbortSignal,
  ): Promise<string[]> {
    const candidates: string[] = [];
    try {
      const iterator = glob(params.include, {
        cwd: params.basePath,
        exclude: DEFAULT_DISCOVERY_EXCLUDES,
      });
      for await (const entry of iterator) {
        throwIfReadAborted(signal);
        candidates.push(entry);
      }
    } catch (cause: unknown) {
      if (signal.aborted) throw cause;
      const detail = cause instanceof Error ? cause.message : String(cause);
      throw new Error(`文件模式匹配失败: ${detail}`, { cause });
    }
    return candidates;
  }

  /** 在单个文件内累积命中；返回 true 表示已达到计数上限，调用方应停止扫描。 */
  #matchFile(
    relative: string,
    source: string,
    regex: RegExp,
    accumulator: GrepAccumulator,
    ceiling: number,
  ): boolean {
    const lines = source.split("\n");
    for (const [index, line] of lines.entries()) {
      if (!regex.test(line)) continue;
      accumulator.total += 1;
      if (accumulator.lines.length < this.#maxMatches) {
        accumulator.lines.push(`${relative}:${index + 1}: ${clipLine(line)}`);
      }
      if (accumulator.total >= ceiling) return true;
    }
    return false;
  }

  public close(): Promise<void> {
    return Promise.resolve();
  }
}

/** 超长行按上限截断，避免压缩后仍撑爆单条上下文。 */
function clipLine(line: string): string {
  if (line.length <= MAX_GREP_LINE_CHARS) return line;
  return `${line.slice(0, MAX_GREP_LINE_CHARS)}…`;
}
