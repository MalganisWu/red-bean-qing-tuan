import type { FileHandle } from "node:fs/promises";

import type { JsonObject, JsonValue } from "../../../protocol/json.js";

/** 单次读取的字节上限（256KiB）；超出的文件必须先确认大小，再用 offset/limit 分片读。 */
export const MAX_READ_SIZE_BYTES = 256 * 1_024;
/** 单次输出交给模型的 token 上限（估算值）；与字节上限互为兜底，谁先到算谁。 */
export const MAX_READ_TOKENS = 25_000;
/** 未指定 limit 时默认读取的行数。 */
export const MAX_LINES_TO_READ = 2_000;
/**
 * 「文件没变过」的占位回复。命中时 Read 只回这一句，不再重发内容——
 * 同一份文件在一个会话里被反复读是常见行为，每次都把全文塞回上下文是纯粹的浪费。
 * 文案保留英文：它是给模型读的，与用户界面的本地化无关。
 */
export const FILE_UNCHANGED_STUB =
  "File unchanged since last read. The content from the earlier Read tool_result in this conversation is still current — refer to that instead of re-reading.";

/** 校验并归一化后的文件读取范围。 */
export interface ReadFileParams {
  readonly filePath: string;
  readonly offset: number;
  readonly limit: number;
  readonly ranged: boolean;
}

/** 带原始总行数的有界文本读取结果。 */
export interface ReadLinesResult {
  readonly content: string;
  readonly totalLines: number;
}

/** 已打开文件句柄及其稳定去重键；调用方负责关闭句柄。 */
export interface OpenedFile {
  readonly handle: FileHandle;
  readonly key: string;
}

function isObject(value: JsonValue): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optionalInteger(value: JsonObject, key: string): number {
  const field = value[key];
  if (field === undefined || field === null) return 0;
  if (typeof field !== "number" || !Number.isSafeInteger(field)) {
    throw new Error(`${key} must be an integer`);
  }
  return field;
}

/**
 * 校验并归一化入参。`offset`/`limit` 给非正数或省略时按默认值处理（从第 1 行、读满上限）。
 * `ranged` 标记「调用方是否显式指定了范围」——读取工具据此决定要不要强制重新读取，
 * 与「读了多少」是两回事。
 *
 * @param value - 工具入参的原始 `unknown` 值，尚未经过任何校验
 * @returns 校验并归一化后的读取范围；入参非法时抛错
 */
export function parseReadFileParams(value: JsonValue): ReadFileParams {
  if (!isObject(value)) throw new Error("read parameters must be an object");
  const filePath = value["file_path"];
  if (typeof filePath !== "string" || filePath.length === 0) {
    throw new Error("file_path 不能为空");
  }
  const rawOffset = optionalInteger(value, "offset");
  const rawLimit = optionalInteger(value, "limit");
  return {
    filePath,
    offset: rawOffset > 0 ? rawOffset : 1,
    limit: rawLimit > 0 ? rawLimit : MAX_LINES_TO_READ,
    ranged: rawOffset > 0 || rawLimit > 0,
  };
}

/**
 * 取取消原因并抛出；优先沿用 `signal.reason`，不把它换成通用文案。
 *
 * @param signal - 调用方传入的取消信号，仅在已中止时才有副作用
 */
export function throwIfReadAborted(signal: AbortSignal): void {
  if (!signal.aborted) return;
  throw signal.reason instanceof Error
    ? signal.reason
    : new DOMException("operation aborted", "AbortError");
}

/**
 * 与压缩侧同一套粗略换算：ASCII 约 4 字符 1 token、非 ASCII 1 字符 1 token。只用于量级判断，不作精确计费。
 *
 * @param value - 待估算的文本内容
 * @returns 估算出的 token 数，仅作量级参考
 */
export function roughTokenCount(value: string): number {
  let ascii = 0;
  let nonAscii = 0;
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint !== undefined && codePoint < 128) ascii += 1;
    else nonAscii += 1;
  }
  return Math.ceil(ascii / 4) + nonAscii;
}

/**
 * 按行区间取出内容，每行前面加「行号 + 制表符」。
 *
 * 行号是必需的：模型要引用代码位置，而它随后调用 Edit 时用的就是这些行号。
 * 制表符分隔是为了让行号与内容有明确边界——用空格的话，内容以空格开头时就会歧义。
 * `totalLines` 单独返回真实总行数，让调用方能在只读了片段时如实告知还有多少。
 *
 * @param source - 文件全文，读取分片在此之上切分
 * @param offset - 起始行号，从 1 开始，由 `parseReadFileParams` 保证为正
 * @param limit - 本次最多读取的行数
 * @param signal - 取消信号，逐行输出前检查
 * @returns 带行号的内容片段与文件真实总行数
 */
export function readNumberedLines(
  source: string,
  offset: number,
  limit: number,
  signal: AbortSignal,
): ReadLinesResult {
  const normalized = source.endsWith("\n") ? source.slice(0, -1) : source;
  const lines = normalized.split("\n");
  const end = Math.min(offset + limit - 1, lines.length);
  let content = "";
  for (let index = offset - 1; index < end; index += 1) {
    throwIfReadAborted(signal);
    const line = lines[index];
    if (line !== undefined) content += `${index + 1}\t${line}\n`;
  }
  return { content, totalLines: lines.length };
}
