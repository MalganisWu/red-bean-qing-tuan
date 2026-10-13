import type { ToolCall } from "../../tool/definition/tool.js";

/** 单个流式 Tool Call 的分片缓冲快照。 */
export interface ToolCallEntry {
  /** 工具调用 ID；通常只在第一片增量里出现。 */
  readonly id: string;
  /** 工具名的分片；组装时非空即整体替换而非追加，避免名字被重复下发时被拼接。 */
  readonly nameParts: readonly string[];
  /** 参数 JSON 的增量分片；按到达顺序拼接成完整参数。 */
  readonly argumentParts: readonly string[];
}

/**
 * 把流式累积的 Tool Call 片段拼成完整调用，按 `index` 排序。
 *
 * 必须排序：模型是并发下发多个工具调用的，分片按到达顺序进 Map，
 * 与调用本身的先后无关。不排序会让工具的执行顺序随网络抖动而变，
 * 对「先读后写」这类有顺序依赖的批次是致命的。
 * 名字与参数各自 `join("")`，因为同一字段也可能被切成多个增量片段。
 *
 * @param buffer - 按 `index` 索引的组装缓冲；缺失 index 的分片已在写入时按 0 归一。
 * @returns 按 `index` 升序排列的完整工具调用。
 */
export function assembleToolCalls(
  buffer: ReadonlyMap<number, ToolCallEntry>,
): readonly ToolCall[] {
  return [...buffer.entries()]
    .sort(([leftIndex], [rightIndex]): number => leftIndex - rightIndex)
    .map(([index, entry]): ToolCall => ({
      index,
      id: entry.id,
      type: "function",
      function: {
        name: entry.nameParts.join(""),
        arguments: entry.argumentParts.join(""),
      },
    }));
}
