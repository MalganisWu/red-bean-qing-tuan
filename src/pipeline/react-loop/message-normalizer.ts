import type { LlmChunk } from "../../llm/model/model.js";
import { EVENT_TYPES, type RuntimeEvent } from "../../protocol/event.js";

/** 生成事件时间戳的可替换毫秒时钟。 */
export type MillisecondClock = () => number;

/**
 * 把一个模型 chunk 翻译成对外的运行事件。一个 chunk 可能同时带推理与正文，
 * 因此返回的是数组而非单个事件。
 *
 * 两类事件的形状刻意不同：推理（REASON）带 `step` 与时间戳，因为展示层要把它按轮次
 * 归组并计算耗时；正文（TOKEN）不带，它是纯增量的文本流，下游直接拼接即可。
 *
 * @param chunk - 模型流的一个增量；可能同时带推理与正文，也可能两者皆空。
 * @param step - 当前轮次序号，从 1 起，只写进推理事件供展示层归组。
 * @param clock - 取时间戳的毫秒时钟，默认 `Date.now`；注入以便测试得到确定的时间戳。
 * @returns 该 chunk 翻译出的零到两个事件，顺序固定为「推理在前、正文在后」。
 */
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
