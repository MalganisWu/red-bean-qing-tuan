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

const MAX_EMPTY_RESPONSE_RETRIES = 2;

/** 单次模型流结束后交给 ReAct 主循环的文本、Tool Call 与终止原因。 */
export interface ModelTurnResult {
  readonly contentParts: readonly string[];
  readonly toolBuffer: ReadonlyMap<number, MutableToolCallEntry>;
  readonly finishReason: string;
}

interface ModelTurnOptions {
  readonly adapter: LlmAdapter;
  readonly request: LlmRequest;
  readonly context: RuntimeContext;
  readonly iteration: number;
  readonly llmParams: LlmRunParams;
  readonly messages: RawMessage[];
  readonly systemOffset: number;
  readonly result: ReactResult;
  readonly onMessage: MessageObserver | undefined;
  readonly signal: AbortSignal;
}

/** 完成一次模型回合；空响应重试与流资源关闭都在这一层闭环。 */
export async function executeModelTurn(
  options: ModelTurnOptions,
): Promise<ModelTurnResult> {
  let contentParts: string[] = [];
  let toolBuffer = new Map<number, MutableToolCallEntry>();
  let finishReason = "";

  for (let emptyAttempt = 0; ; emptyAttempt += 1) {
    let usageCounted = false;
    const streamController = new AbortController();
    const streamSignal = AbortSignal.any([
      options.signal,
      streamController.signal,
    ]);
    let iterable: AsyncIterable<LlmChunk>;
    try {
      iterable = await runWithLlmRetry(
        options.llmParams,
        sleepWithSignal,
        (attempt: number, maximum: number): void => {
          options.context.emit({
            type: EVENT_TYPES.STATUS,
            code: STATUS_CODES.LLM_RETRY,
            attempt: attempt + 1,
            maxAttempts: maximum + 1,
          });
        },
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
    const persistPartial = async (): Promise<void> => {
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
    };

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
      if (error instanceof ReactLoopError) throw error;
      failReactLoop(options.result, error.message, error);
    }
    streamController.abort();

    const empty =
      contentParts.length === 0 && toolBuffer.size === 0 && finishReason === "";
    if (!empty) return { contentParts, toolBuffer, finishReason };
    if (emptyAttempt >= MAX_EMPTY_RESPONSE_RETRIES) {
      failReactLoop(
        options.result,
        `LLM returned ${emptyAttempt + 1} consecutive empty responses`,
      );
    }
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
