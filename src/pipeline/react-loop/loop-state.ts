import type { RuntimeConfig } from "../config/runtime-config.js";
import type { LlmAdapter } from "../../llm/adapter/port/llm-adapter.js";
import type { ModelParams } from "../../llm/model/model.js";
import type { Interrupt } from "../../protocol/interrupt.js";
import type { RawMessage } from "../../protocol/message.js";
import type { ToolSchema } from "../../protocol/tool-schema.js";
import type { ToolDispatcher } from "../../tool/dispatcher/port/tool-dispatcher.js";
import type { RuntimeContext } from "../context/runtime-context.js";

/** ReAct 循环终止时返回给上层执行组件的完整状态。 */
export interface ReactResult {
  llmContext: readonly RawMessage[];
  tokensUsed: number;
  finishReason: string;
  cancelled: boolean;
  stopReason: string;
  interrupt?: Interrupt | undefined;
}

export class ReactLoopError extends Error {
  public readonly result: ReactResult;

  public constructor(message: string, result: ReactResult, cause?: Error) {
    super(message, cause ? { cause } : undefined);
    this.name = "ReactLoopError";
    this.result = result;
  }
}

/** 消息提交后的观察回调；消息持久化策略及失败处理由调用方负责。 */
export type MessageObserver = (message: RawMessage) => void | Promise<void>;

/** 运行 ReAct 主循环所需的依赖与单次调用状态。 */
export interface RunReactLoopOptions {
  readonly context: RuntimeContext;
  readonly adapter: LlmAdapter;
  readonly dispatcher: ToolDispatcher;
  readonly tools: readonly ToolSchema[];
  readonly onMessage?: MessageObserver | undefined;
  readonly systemPrompt: string;
  readonly modelParams: ModelParams;
  readonly config: RuntimeConfig;
  readonly signal: AbortSignal;
}

/** 流式接收 Tool Call 增量时使用的内部可变组装状态。 */
export interface MutableToolCallEntry {
  id: string;
  nameParts: string[];
  argumentParts: string[];
}

export function normalizeLoopError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

export function abortLoopError(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new DOMException("operation aborted", "AbortError");
}

/** 统一的失败出口：把当前进度装进 `ReactLoopError` 再抛，保证异常里带着可诊断的部分状态。 */
export function failReactLoop(
  result: ReactResult,
  message: string,
  cause?: Error,
): never {
  throw new ReactLoopError(message, result, cause);
}

/**
 * 剥掉系统提示词，得到要持久化的可见上下文。
 * `systemOffset` 是循环开头记录的前缀长度（0 或 1）——用偏移量而非按内容过滤，
 * 是为了让「只有紧跟开头的那条 system 消息」被排除，历史中间出现的 system 消息照常保留。
 */
export function copyVisibleContext(
  messages: readonly RawMessage[],
  systemOffset: number,
): RawMessage[] {
  return messages.slice(systemOffset);
}

/**
 * 提交一条消息：先入内存数组，再通知观察者。
 *
 * 顺序不能反——`onMessage` 由宿主实现，可能异步落库；先入数组保证即使观察者抛错，
 * 内存里的对话状态也与已发生的事实一致（调用方随后会把 messages 快照进错误的 `llmContext`）。
 */
export async function persistLoopMessage(
  messages: RawMessage[],
  message: RawMessage,
  onMessage: MessageObserver | undefined,
): Promise<void> {
  messages.push(message);
  await onMessage?.(message);
}
