import type { ToolCall } from "../../tool/definition/tool.js";

/** 单个流式 Tool Call 的分片缓冲快照。 */
export interface ToolCallEntry {
  readonly id: string;
  readonly nameParts: readonly string[];
  readonly argumentParts: readonly string[];
}

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
