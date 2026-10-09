import type { JsonObject } from "./json.js";

export const EVENT_TYPES = Object.freeze({
  TOKEN: "token",
  STATUS: "status",
  TOOL_START: "tool_start",
  TOOL_RESULT: "tool_result",
  REASON: "reason",
  COMPACTION: "compaction",
} as const);

export const STATUS_CODES = Object.freeze({
  THINKING: "thinking",
  ANALYZING_RESULTS: "analyzing_results",
  LLM_RETRY: "llm_retry",
  LLM_EMPTY_RESPONSE_RETRY: "llm_empty_response_retry",
} as const);

/** Runtime 状态事件的稳定机器码；展示文案由宿主映射。 */
export type StatusCode = (typeof STATUS_CODES)[keyof typeof STATUS_CODES];

/** 模型流产生的一段可展示文本。 */
export interface TokenEvent {
  readonly type: typeof EVENT_TYPES.TOKEN;
  readonly content: string;
}

/** Runtime 生命周期状态；code 由宿主映射为本地化文案。 */
export interface StatusEvent {
  readonly type: typeof EVENT_TYPES.STATUS;
  readonly code?: StatusCode | undefined;
  readonly attempt?: number | undefined;
  readonly maxAttempts?: number | undefined;
}

/** 工具开始执行时发出的中性事件。 */
export interface ToolStartEvent {
  readonly type: typeof EVENT_TYPES.TOOL_START;
  readonly toolName: string;
  readonly callId: string;
  readonly params: JsonObject | null;
}

/** 工具结束事件；失败信息保持结构化，不携带宿主错误对象。 */
export interface ToolResultEvent {
  readonly type: typeof EVENT_TYPES.TOOL_RESULT;
  readonly toolName: string;
  readonly callId: string;
  readonly content: string;
  readonly error?: string | undefined;
}

/** 模型推理内容事件；是否展示或持久化由宿主决定。 */
export interface ReasonEvent {
  readonly type: typeof EVENT_TYPES.REASON;
  readonly content: string;
  readonly step: number;
  readonly timestamp: number;
}

/** 上下文压缩完成后的用量摘要。 */
export interface CompactionEvent {
  readonly type: typeof EVENT_TYPES.COMPACTION;
  readonly trigger: "auto" | "manual";
  readonly preTokens: number;
  readonly postTokens: number;
  readonly messagesSummarized: number;
}

/** Runtime 对外发出的中性事件联合，不等同于 SSE 或 WebSocket 帧。 */
export type RuntimeEvent =
  | CompactionEvent
  | ReasonEvent
  | StatusEvent
  | TokenEvent
  | ToolResultEvent
  | ToolStartEvent;

/** 将中性 Runtime 事件映射为稳定的 snake_case wire 载荷。 */
export function serializeRuntimeEvent(event: RuntimeEvent): JsonObject {
  switch (event.type) {
    case EVENT_TYPES.TOKEN:
      return { content: event.content };
    case EVENT_TYPES.STATUS: {
      const payload: Record<string, string | number> = {};
      if (event.code !== undefined) payload["code"] = event.code;
      if (event.attempt !== undefined && event.attempt !== 0)
        payload["attempt"] = event.attempt;
      if (event.maxAttempts !== undefined && event.maxAttempts !== 0) {
        payload["max_attempts"] = event.maxAttempts;
      }
      return payload;
    }
    case EVENT_TYPES.TOOL_START:
      return {
        tool_name: event.toolName,
        call_id: event.callId,
        params: event.params,
      };
    case EVENT_TYPES.TOOL_RESULT: {
      const payload: Record<string, string> = {
        tool_name: event.toolName,
        call_id: event.callId,
        content: event.content,
      };
      if (event.error !== undefined && event.error !== "")
        payload["error"] = event.error;
      return payload;
    }
    case EVENT_TYPES.REASON:
      return {
        content: event.content,
        step: event.step,
        timestamp: event.timestamp,
      };
    case EVENT_TYPES.COMPACTION:
      return {
        trigger: event.trigger,
        pre_tokens: event.preTokens,
        post_tokens: event.postTokens,
        messages_summarized: event.messagesSummarized,
      };
  }
}
