import type { LlmAdapter } from "../../llm/adapter/port/llm-adapter.js";
import type { LlmChunk, LlmRequest } from "../../llm/model/model.js";
import { EVENT_TYPES, STATUS_CODES } from "../../protocol/event.js";
import type { RawMessage } from "../../protocol/message.js";
import type { RuntimeContext } from "../context/runtime-context.js";
import type { LlmRunParams } from "./llm-retry.js";
import { runWithLlmRetry, sleepWithSignal } from "./llm-retry.js";
import {
  ReactLoopError,
  copyVisibleContext,
  failReactLoop,
  normalizeLoopError,
  type MessageObserver,
  type MutableToolCallEntry,
  type ReactResult,
} from "./loop-state.js";
import { normalizeChunk } from "./message-normalizer.js";
import { closeModelIterator, nextModelChunk } from "./model-step.js";
import { updateToolCallBuffer } from "./tool-step.js";

/**
 * 完全空响应（没有正文、没有工具调用、没有终止原因）的重试次数。
 * 这类响应多半是上游的偶发抖动，重试有意义；但它也意味着「这一次什么都没发生」，
 * 所以重试前必须把累积的片段全部清空，不能与上一次的残留拼在一起。
 */
const MAX_EMPTY_RESPONSE_RETRIES = 2;

/** 单次模型流结束后交给 ReAct 主循环的文本、Tool Call 与终止原因。 */
export interface ModelTurnResult {
  /** 本回合累积的正文片段，尚未拼接成完整字符串。 */
  readonly contentParts: readonly string[];
  /** 本回合累积的 Tool Call 组装缓冲，按 index 索引，供后续拼成完整调用。 */
  readonly toolBuffer: ReadonlyMap<number, MutableToolCallEntry>;
  /** 本回合的终止原因原文；空串表示模型没有给出明确原因。 */
  readonly finishReason: string;
}

/** 单次模型回合所需的依赖与共享状态；`messages` 与 `result` 会被就地更新。 */
interface ModelTurnOptions {
  /** LLM 适配器，用于发起模型流。 */
  readonly adapter: LlmAdapter;
  /** 本回合要发送的完整模型请求。 */
  readonly request: LlmRequest;
  /** 本次运行上下文，用于发出状态与流事件。 */
  readonly context: RuntimeContext;
  /** 当前轮次序号（从 1 起），用于事件归因。 */
  readonly iteration: number;
  /** 重试与空闲超时参数，透传给重试封装。 */
  readonly llmParams: LlmRunParams;
  /** 循环内的消息数组；本回合会就地追加消息。 */
  readonly messages: RawMessage[];
  /** 开头系统提示词的条数（0 或 1），用于剥离出可见上下文。 */
  readonly systemOffset: number;
  /** 本次运行的循环结果；本回合会就地更新其 tokensUsed 与 llmContext。 */
  readonly result: ReactResult;
  /** 消息提交后的观察回调；省略则只入内存，不对外通知。 */
  readonly onMessage: MessageObserver | undefined;
  /** 整次运行的取消信号；已中止时本回合会以取消错误收场。 */
  readonly signal: AbortSignal;
}

/**
 * 完成一次模型回合；空响应重试与流资源关闭都在这一层闭环。
 *
 * 每轮尝试有自己的 `streamController`，与外层取消信号合成 `streamSignal`：
 * 这样单次尝试结束时能主动关掉这条流（`streamController.abort()`），
 * 而不必、也不能去动外层的取消信号。
 *
 * @param options - 单次回合所需的依赖与共享状态；`messages` 与 `result` 会被就地更新。
 * @returns 本回合累积的正文片段、Tool Call 组装缓冲与终止原因。
 */
export async function executeModelTurn(
  options: ModelTurnOptions,
): Promise<ModelTurnResult> {
  let contentParts: string[] = [];
  let toolBuffer = new Map<number, MutableToolCallEntry>();
  let finishReason = "";

  for (let emptyAttempt = 0; ; emptyAttempt += 1) {
    // usage 可能出现在多个 chunk 里，但只应计入一次。
    let usageCounted = false;
    const streamController = new AbortController();
    const streamSignal = AbortSignal.any([
      options.signal,
      streamController.signal,
    ]);
    // 每次重试前播报一次状态；对外口径不含首次尝试，因此两个计数都加一。
    function emitRetryStatus(attempt: number, maximum: number): void {
      options.context.emit({
        type: EVENT_TYPES.STATUS,
        code: STATUS_CODES.LLM_RETRY,
        attempt: attempt + 1,
        maxAttempts: maximum + 1,
      });
    }

    let iterable: AsyncIterable<LlmChunk>;
    try {
      iterable = await runWithLlmRetry(
        options.llmParams,
        sleepWithSignal,
        emitRetryStatus,
        (): Promise<AsyncIterable<LlmChunk>> =>
          options.adapter.streamCompletion(options.request, streamSignal),
        streamSignal,
      );
    } catch (value: unknown) {
      streamController.abort();
      if (options.signal.aborted) options.result.cancelled = true;
      const error = normalizeLoopError(value);
      failReactLoop(options.result, error.message, error);
    }

    const iterator = iterable[Symbol.asyncIterator]();
    // 流中途失败时，把已经吐出来的正文落成一条 assistant 消息。
    // 不这么做的话，模型已经说了半段话，而这些内容既不在上下文里也没给用户看过，就直接消失了。
    // hook 自身抛错被吞掉是刻意的——此刻真正要报的是 stream 的错，不能被 hook 的错顶掉。
    async function persistPartial(): Promise<void> {
      const content = contentParts.join("");
      if (content === "") return;
      const message: RawMessage = { role: "assistant", content };
      options.messages.push(message);
      try {
        await options.onMessage?.(message);
      } catch {
        // 部分消息 hook 的错误不能掩盖原始 stream 错误。
      }
      options.result.llmContext = copyVisibleContext(
        options.messages,
        options.systemOffset,
      );
    }

    try {
      for (;;) {
        const item = await nextModelChunk(
          iterator,
          options.llmParams.idleTimeoutMs,
          streamSignal,
        );
        if (item.done) break;
        const chunk = item.value;
        if (chunk.error) {
          await persistPartial();
          failReactLoop(
            options.result,
            `LLM stream failed: ${chunk.error.message}`,
            chunk.error,
          );
        }
        for (const event of normalizeChunk(chunk, options.iteration + 1)) {
          options.context.emit(event);
        }
        if (chunk.content) contentParts.push(chunk.content);
        if (chunk.finishReason !== undefined && chunk.finishReason !== null) {
          finishReason = chunk.finishReason;
        }
        if (chunk.usage && !usageCounted) {
          options.result.tokensUsed += chunk.usage.totalTokens;
          usageCounted = true;
        }
        updateToolCallBuffer(toolBuffer, chunk.toolCalls ?? []);
      }
    } catch (value: unknown) {
      streamController.abort();
      void closeModelIterator(iterator);
      await persistPartial();
      if (options.signal.aborted) options.result.cancelled = true;
      const error = normalizeLoopError(value);
      // `chunk.error` 分支就在上面的 try 里调用 failReactLoop，它抛出的 ReactLoopError
      // 会落到这里。原样再抛一次，否则会被下面的 failReactLoop 包成第二层，错误链多一层噪音。
      if (error instanceof ReactLoopError) throw error;
      failReactLoop(options.result, error.message, error);
    }
    // 正常读完后同样要关闭流：迭代器被丢弃不等于底层连接已归还。
    streamController.abort();

    // 三项全空才算「什么都没发生」。只要有 finishReason 就不算空——
    // 模型明确说了「我结束于某个原因」，重试它没有意义。
    const empty =
      contentParts.length === 0 && toolBuffer.size === 0 && finishReason === "";
    if (!empty) return { contentParts, toolBuffer, finishReason };
    if (emptyAttempt >= MAX_EMPTY_RESPONSE_RETRIES) {
      failReactLoop(
        options.result,
        `LLM returned ${emptyAttempt + 1} consecutive empty responses`,
      );
    }
    // 重试前清空累积状态，避免把两次空响应的碎片拼成一条消息。
    contentParts = [];
    toolBuffer = new Map<number, MutableToolCallEntry>();
    finishReason = "";
    options.context.emit({
      type: EVENT_TYPES.STATUS,
      code: STATUS_CODES.LLM_EMPTY_RESPONSE_RETRY,
      attempt: emptyAttempt + 2,
      maxAttempts: MAX_EMPTY_RESPONSE_RETRIES + 1,
    });
  }
}
