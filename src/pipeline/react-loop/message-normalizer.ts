import type { LlmChunk } from "../../llm/model/model.js";
import { EVENT_TYPES, type RuntimeEvent } from "../../protocol/event.js";

/** 生成事件时间戳的可替换毫秒时钟。 */
export type MillisecondClock = () => number;

export function normalizeChunk(
  chunk: LlmChunk,
  step: number,
  clock: MillisecondClock = Date.now,
): readonly RuntimeEvent[] {
  const events: RuntimeEvent[] = [];
  if (chunk.reasoningContent) {
    events.push({
      type: EVENT_TYPES.REASON,
      content: chunk.reasoningContent,
      step,
      timestamp: clock(),
    });
  }
  if (chunk.content) {
    events.push({ type: EVENT_TYPES.TOKEN, content: chunk.content });
  }
  return events;
}
