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

/**
 * 循环失败时抛出的错误，**始终携带出错那一刻的 `ReactResult`**。
 * 这是它存在的全部意义：一次跑了一半的循环里已经有模型输出、工具结果和 token 消耗，
 * 这些不该因为抛出而消失。上层（`ReactAgentExecution`）会把 `result.llmContext`
 * 写回上下文并持久化，让失败的运行也能留下进展。
 */
export class ReactLoopError extends Error {
  /**
   * 抛出那一刻的状态快照，随错误一路带到上层。
   *
   * 做成公开字段而不是塞进 message，是为了让上层能直接读到 `llmContext` 并持久化——
   * 失败之前已经产生的模型输出与工具结果不该只以文本形式留在异常信息里。
   */
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

/**
 * 把任意抛出物统一成 Error；非 Error 一律 `String(...)`，不做结构探测。
 *
 * @param value - 任意抛出物；是 Error 时原样返回，否则只做字符串化，不保留其结构。
 * @returns 一定是 Error 实例；非 Error 输入被包装成消息为 `String(value)` 的新 Error。
 */
export function normalizeLoopError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

/**
 * 取取消原因；优先沿用 `signal.reason`，调用方通过 `abort(customReason)` 传入的原因不该被换掉。
 *
 * @param signal - 取消信号；只读取其 reason，不会改变信号自身状态。
 * @returns `signal.reason` 是 Error 时原样返回，否则补一个通用的 AbortError。
 */
export function abortLoopError(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new DOMException("operation aborted", "AbortError");
}

/**
 * 统一的失败出口：把当前进度装进 `ReactLoopError` 再抛，保证异常里带着可诊断的部分状态。
 *
 * @param result - 失败那一刻的循环状态，会被原样挂到抛出的错误上。
 * @param message - 面向人的失败原因，直接作为 `ReactLoopError` 的 message。
 * @param cause - 可选的底层原因，用于保留原始错误链；省略时不设 cause。
 */
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
 *
 * @param messages - 循环内的完整消息数组，开头可能含系统提示词。
 * @param systemOffset - 开头要跳过的条数（0 或 1），由循环开头是否注入系统提示词决定。
 * @returns 从 `systemOffset` 起的浅拷贝片段；原数组不被修改。
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
 *
 * @param messages - 对话消息数组；消息会被就地追加到末尾。
 * @param message - 本次要提交的消息。
 * @param onMessage - 消息提交后的观察回调；省略则只入内存，不对外通知，其抛错会向上传播。
 */
export async function persistLoopMessage(
  messages: RawMessage[],
  message: RawMessage,
  onMessage: MessageObserver | undefined,
): Promise<void> {
  messages.push(message);
  await onMessage?.(message);
}
