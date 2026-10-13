import type { JsonObject } from "./json.js";

/** Runtime 中性事件的类型标签；同时作为可辨识联合的判别字段与 wire 上的 `type`。 */
export const EVENT_TYPES = Object.freeze({
  TOKEN: "token",
  STATUS: "status",
  TOOL_START: "tool_start",
  TOOL_RESULT: "tool_result",
  REASON: "reason",
  COMPACTION: "compaction",
} as const);

/**
 * status 事件的机器码。这里刻意不放文案：Runtime 不拼面向用户的句子，
 * 宿主按码映射本地化文本（产品侧见 `chat-event-presenter.ts`）。
 */
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
  /** 判别字段，固定为 `token`。 */
  readonly type: typeof EVENT_TYPES.TOKEN;
  /** 模型流产生的一段可展示文本增量，按到达顺序拼接即为完整输出。 */
  readonly content: string;
}

/** Runtime 生命周期状态；code 由宿主映射为本地化文案。 */
export interface StatusEvent {
  /** 判别字段，固定为 `status`。 */
  readonly type: typeof EVENT_TYPES.STATUS;
  /** 状态机器码，由宿主映射为本地化文案；未设置表示仅有状态无具体码。 */
  readonly code?: StatusCode | undefined;
  /** 当前重试次数（从 1 起算）；`0` 与未设置等价，序列化时不写出。 */
  readonly attempt?: number | undefined;
  /** 重试上限；仅在可重试场景有意义，`0` 与未设置等价，序列化时不写出。 */
  readonly maxAttempts?: number | undefined;
}

/** 工具开始执行时发出的中性事件。 */
export interface ToolStartEvent {
  /** 判别字段，固定为 `tool_start`。 */
  readonly type: typeof EVENT_TYPES.TOOL_START;
  /** 被调用工具的名字，与 `tool_result` 事件配对。 */
  readonly toolName: string;
  /** 本次调用的唯一标识，用于把开始与结果事件关联到同一次调用。 */
  readonly callId: string;
  /** 已解析的调用参数；无法解析时保留 `null`，不抛错。 */
  readonly params: JsonObject | null;
}

/** 工具结束事件；失败信息保持结构化，不携带宿主错误对象。 */
export interface ToolResultEvent {
  /** 判别字段，固定为 `tool_result`。 */
  readonly type: typeof EVENT_TYPES.TOOL_RESULT;
  /** 被调用工具的名字，与 `tool_start` 事件配对。 */
  readonly toolName: string;
  /** 与 `tool_start` 一致的调用唯一标识，用于关联同一次调用。 */
  readonly callId: string;
  /** 工具的文本结果；失败时可能为空串或部分输出。 */
  readonly content: string;
  /** 结构化的失败信息；`undefined` 与空串都表示成功，序列化时不写出。 */
  readonly error?: string | undefined;
}

/** 模型推理内容事件；是否展示或持久化由宿主决定。 */
export interface ReasonEvent {
  /** 判别字段，固定为 `reason`。 */
  readonly type: typeof EVENT_TYPES.REASON;
  /** 模型推理文本；是否展示或持久化由宿主决定。 */
  readonly content: string;
  /** 推理所属的循环步序号，用于把推理与同一步的工具调用对齐。 */
  readonly step: number;
  /** 推理产生时间戳（毫秒），恒被写出以便按时间排序。 */
  readonly timestamp: number;
}

/** 上下文压缩完成后的用量摘要。 */
export interface CompactionEvent {
  /** 判别字段，固定为 `compaction`。 */
  readonly type: typeof EVENT_TYPES.COMPACTION;
  /** 触发来源：`auto` 为达到阈值自动压缩，`manual` 为宿主显式请求。 */
  readonly trigger: "auto" | "manual";
  /** 压缩前的估算 token 数，用于衡量压缩收益。 */
  readonly preTokens: number;
  /** 压缩后的估算 token 数，用于衡量压缩收益。 */
  readonly postTokens: number;
  /** 被摘要替换掉的消息条数。 */
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

/**
 * 将中性 Runtime 事件映射为稳定的 snake_case wire 载荷。
 *
 * `type` 判别字段本身不进入载荷，由调用方按事件类型另行标注；事件联合是穷尽的，
 * 因此每个分支都有确定输出，不会出现未知类型落到默认分支。
 *
 * @param event - 待序列化的中性事件；只取其 `type` 分支对应的字段。
 * @returns 键序稳定的 JSON 对象；`status` 的 `code` 为 `undefined`、`attempt`/`max_attempts`
 *   为 `0`，以及 `tool_result` 的 `error` 为 `undefined`/空串时都不写出该字段，可参与快照比对。
 */
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
