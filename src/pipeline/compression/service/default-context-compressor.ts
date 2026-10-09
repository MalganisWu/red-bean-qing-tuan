import type { CompressionConfig } from "../../config/runtime-config.js";
import type {
  LlmChunk,
  LlmRequest,
  ModelParams,
} from "../../../llm/model/model.js";
import type { LlmAdapter } from "../../../llm/adapter/port/llm-adapter.js";
import {
  CONTENT_REFS_METADATA_KEY,
  type ContentRef,
} from "../../../protocol/content-reference.js";
import { EVENT_TYPES } from "../../../protocol/event.js";
import type { RawMessage } from "../../../protocol/message.js";
import type { RuntimeContext } from "../../context/runtime-context.js";
import type { ContextCompressor } from "../port/context-compression.js";
import { estimateTokens } from "../token-counter.js";

const DEFAULT_MAX_SUMMARY_TOKENS = 20_000;
const AUTO_COMPACT_BUFFER_TOKENS = 13_000;
const MAX_CONSECUTIVE_FAILURES = 3;
const DEFAULT_IDLE_TIMEOUT_MS = 30_000;

const NO_TOOLS_PREAMBLE = `- Do NOT use any tool (Read, Bash, Grep, Glob, Edit, Write, or ANY other).
- You already have all the context you need in the conversation above.
- Tool calls will be REJECTED and will waste your only turn — you will fail the task.
- Your entire response must be plain text: an <analysis> block followed by a <summary> block.

`;

const BASE_COMPACT_PROMPT = `Your task is to create a detailed summary of the conversation so far, paying close attention to the user's explicit requests and your previous actions.
This summary should be thorough in capturing technical details, code patterns, and architectural decisions that would be essential for continuing development work without losing context.

Before providing your final summary, wrap your analysis in <analysis> tags to organize your thoughts and ensure you've covered all necessary points. Chronologically analyze each message and section of the conversation, thoroughly identifying the user's explicit requests and intents, your approach, key decisions, technical concepts, code patterns, specific details (file names, full code snippets, function signatures, file edits), errors encountered and how you fixed them, and specific user feedback.

Your summary should include the following sections:

1. Primary Request and Intent
2. Key Technical Concepts
3. Files and Code Sections
4. Errors and fixes
5. Problem Solving
6. All user messages
7. Pending Tasks
8. Current Work
9. Optional Next Step

Your entire response must be plain text: an <analysis> block followed by a <summary> block containing the sections above. Be precise and thorough.`;

function normalizeError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new DOMException("operation aborted", "AbortError");
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isSafeInteger(value) && value > 0
    ? value
    : fallback;
}

function isContentRef(value: unknown): value is ContentRef {
  return (
    typeof value === "object" &&
    value !== null &&
    "kind" in value &&
    typeof value.kind === "string" &&
    "key" in value &&
    typeof value.key === "string"
  );
}

function collectContentRefs(context: RuntimeContext): ContentRef[] {
  const value = context.metadata.get(CONTENT_REFS_METADATA_KEY);
  if (!Array.isArray(value)) return [];
  const references: ContentRef[] = [];
  for (const candidate of value) {
    if (isContentRef(candidate)) references.push(candidate);
  }
  return references;
}

function buildCompactPrompt(customInstructions: string): string {
  const base = NO_TOOLS_PREAMBLE + BASE_COMPACT_PROMPT;
  const custom = customInstructions.trim();
  return custom === ""
    ? base
    : `${base}\n\nAdditional Instructions:\n${custom}`;
}

export function formatCompactSummary(summary: string): string {
  let formatted = summary.replace(/<analysis>[\s\S]*?<\/analysis>/g, "");
  const match = /<summary>([\s\S]*?)<\/summary>/.exec(formatted);
  const content = match?.[1];
  if (content !== undefined) formatted = `Summary:\n${content.trim()}`;
  return formatted.trim();
}

function buildBoundaryMessage(
  preTokens: number,
  summarized: number,
): RawMessage {
  return {
    role: "system",
    content: `Conversation compacted (trigger: auto, pre_tokens: ${preTokens}, messages_summarized: ${summarized})`,
  };
}

function buildSummaryMessage(summary: string): RawMessage {
  return {
    role: "user",
    content: `This session is being continued from a previous conversation that ran out of context. The summary below covers the earlier portion of the conversation.

${summary}

Continue the conversation from where it left off without asking the user any further questions. Resume directly — do not acknowledge the summary, do not recap what was happening, do not preface with "I'll continue" or similar. Pick up the last task as if the break never happened.`,
  };
}

function splitSystemMessages(messages: readonly RawMessage[]): number {
  for (let index = 0; index < messages.length; index += 1) {
    if (messages[index]?.role !== "system") return index;
  }
  return messages.length;
}

async function nextWithTimeout(
  iterator: AsyncIterator<LlmChunk>,
  signal: AbortSignal,
  timeoutMs: number,
  timeoutController: AbortController,
): Promise<IteratorResult<LlmChunk>> {
  if (signal.aborted) throw abortError(signal);
  let onAbort: (() => void) | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const interrupted = new Promise<never>((_resolve, reject): void => {
    onAbort = (): void => reject(abortError(signal));
    signal.addEventListener("abort", onAbort, { once: true });
    timer = setTimeout((): void => {
      const error = new Error(`summary stream idle for ${timeoutMs}ms`);
      timeoutController.abort(error);
      reject(error);
    }, timeoutMs);
  });
  try {
    return await Promise.race([iterator.next(), interrupted]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    if (onAbort) signal.removeEventListener("abort", onAbort);
  }
}

/** 基于 Token 阈值压缩历史消息的默认实现；摘要失败由 ReAct 主循环按尽力语义降级。 */
export class DefaultCompressor implements ContextCompressor {
  readonly #adapter: LlmAdapter;
  readonly #config: CompressionConfig;
  readonly #modelParams: ModelParams;
  #consecutiveFailures = 0;

  public constructor(
    adapter: LlmAdapter,
    config: CompressionConfig,
    modelParams: ModelParams,
  ) {
    this.#adapter = adapter;
    this.#config = config;
    this.#modelParams = modelParams;
  }

  public shouldCompact(
    _context: RuntimeContext,
    messages: readonly RawMessage[],
    signal: AbortSignal,
  ): Promise<boolean> {
    if (signal.aborted) return Promise.reject(abortError(signal));
    if (this.#config.enabled !== true) return Promise.resolve(false);
    if (this.#consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
      return Promise.resolve(false);
    }
    const threshold = this.#autoCompactThreshold();
    return Promise.resolve(
      threshold > 0 && estimateTokens(messages) >= threshold,
    );
  }

  public async compress(
    context: RuntimeContext,
    messages: readonly RawMessage[],
    signal: AbortSignal,
  ): Promise<readonly RawMessage[]> {
    if (signal.aborted) throw abortError(signal);
    const preTokens = estimateTokens(messages);
    const historyStart = splitSystemMessages(messages);
    const keepRecent = Math.max(
      0,
      Number.isSafeInteger(this.#config.keepRecent)
        ? (this.#config.keepRecent ?? 0)
        : 0,
    );
    const tailCount = Math.min(
      messages.length - historyStart,
      context.messages.length + keepRecent,
    );
    let summarizeEnd = messages.length - tailCount;
    while (summarizeEnd > historyStart) {
      const previous = messages[summarizeEnd - 1];
      const next = messages[summarizeEnd];
      const previousHasPendingTools = (previous?.toolCalls?.length ?? 0) > 0;
      const nextIsTool = next?.role === "tool";
      if (!previousHasPendingTools && !nextIsTool) break;
      summarizeEnd -= 1;
    }
    if (summarizeEnd <= historyStart) return [...messages];

    let summary: string;
    try {
      summary = await this.#summarize(messages.slice(0, summarizeEnd), signal);
    } catch (cause: unknown) {
      this.#consecutiveFailures += 1;
      throw new Error(`compress summary: ${normalizeError(cause).message}`, {
        cause,
      });
    }
    this.#consecutiveFailures = 0;

    const output: RawMessage[] = [
      ...messages.slice(0, historyStart),
      buildBoundaryMessage(preTokens, summarizeEnd),
      buildSummaryMessage(summary),
      ...messages.slice(summarizeEnd),
    ];
    const references = collectContentRefs(context);
    if (this.#config.restorer && references.length > 0) {
      try {
        const attachments = await this.#config.restorer.buildAttachments(
          references,
          signal,
        );
        output.push(...attachments);
      } catch (_error: unknown) {
        // 内容恢复为尽力操作，失败不能使已经有效的摘要失效。
      }
    }
    context.emit({
      type: EVENT_TYPES.COMPACTION,
      trigger: "auto",
      preTokens,
      postTokens: estimateTokens(output),
      messagesSummarized: summarizeEnd,
    });
    return output;
  }

  #autoCompactThreshold(): number {
    if (this.#config.triggerThreshold !== undefined) {
      return this.#config.triggerThreshold;
    }
    const contextWindow = this.#modelParams.contextWindow;
    if (contextWindow === undefined) return 0;
    const reserved = Math.min(
      this.#modelParams.maxTokens ?? DEFAULT_MAX_SUMMARY_TOKENS,
      DEFAULT_MAX_SUMMARY_TOKENS,
    );
    return Math.max(0, contextWindow - reserved) - AUTO_COMPACT_BUFFER_TOKENS;
  }

  async #summarize(
    messages: readonly RawMessage[],
    signal: AbortSignal,
  ): Promise<string> {
    const prompt = buildCompactPrompt(this.#config.summaryPrompt ?? "");
    const maxTokens = Math.min(
      this.#modelParams.maxTokens ?? DEFAULT_MAX_SUMMARY_TOKENS,
      DEFAULT_MAX_SUMMARY_TOKENS,
    );
    const request: LlmRequest = {
      messages: [...messages, { role: "user", content: prompt }],
      tools: [],
      params: { ...this.#modelParams, maxTokens },
    };
    const timeoutController = new AbortController();
    const summarySignal = AbortSignal.any([signal, timeoutController.signal]);
    const idleTimeoutMs =
      positiveInteger(
        this.#config.idleTimeoutSeconds,
        DEFAULT_IDLE_TIMEOUT_MS / 1_000,
      ) * 1_000;
    let iterable: AsyncIterable<LlmChunk>;
    try {
      iterable = await this.#adapter.streamCompletion(request, summarySignal);
      const iterator = iterable[Symbol.asyncIterator]();
      const content: string[] = [];
      while (true) {
        const next = await nextWithTimeout(
          iterator,
          summarySignal,
          idleTimeoutMs,
          timeoutController,
        );
        if (next.done) break;
        if (next.value.error) throw next.value.error;
        if (next.value.content !== null) content.push(next.value.content);
      }
      const raw = content.join("").trim();
      if (raw === "") throw new Error("summary response is empty");
      const formatted = formatCompactSummary(raw);
      if (formatted === "") throw new Error("parsed summary is empty");
      return formatted;
    } finally {
      timeoutController.abort(new Error("summary complete"));
    }
  }
}
