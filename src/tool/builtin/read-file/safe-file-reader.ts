import type { FileHandle } from "node:fs/promises";

import type { JsonObject, JsonValue } from "../../../protocol/json.js";

export const MAX_READ_SIZE_BYTES = 256 * 1_024;
export const MAX_READ_TOKENS = 25_000;
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

export function throwIfReadAborted(signal: AbortSignal): void {
  if (!signal.aborted) return;
  throw signal.reason instanceof Error
    ? signal.reason
    : new DOMException("operation aborted", "AbortError");
}

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
