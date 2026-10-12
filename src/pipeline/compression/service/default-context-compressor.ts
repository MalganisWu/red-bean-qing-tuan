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
import { abortError } from "../../../protocol/abort-signal.js";

/** 摘要调用自身的输出上限；与模型声明的 maxTokens 取较小者，避免摘要比被摘要的内容还长。 */
const DEFAULT_MAX_SUMMARY_TOKENS = 20_000;
/** 触发阈值与上下文窗口之间留的余量，用于容纳下一轮的模型输出与工具结果。 */
const AUTO_COMPACT_BUFFER_TOKENS = 13_000;
/** 连续失败这么多次后停止尝试压缩：压缩一直失败通常意味着模型或凭据有系统性问题，重试只会拖慢每一轮。 */
const MAX_CONSECUTIVE_FAILURES = 3;
/** 摘要流的空闲超时；卡住的摘要会阻塞整个 ReAct 循环，宁可失败也不要无限等。 */
const DEFAULT_IDLE_TIMEOUT_MS = 30_000;

/**
 * 摘要请求的提示词由两部分拼成：先禁工具，再给任务。
 *
 * 禁工具这句是必须的：摘要调用复用了主对话的历史，模型会「顺手」去读文件补上下文。
 * 而这次调用只允许一轮，一次工具调用就会把唯一的机会花掉——工具调用的结果是空的，
 * 摘要就再也产不出来了。所以这里用最强的措辞把它钉死。
 */
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

/**
 * 从上下文元数据里取内容引用，并逐条做结构校验。
 * 元数据是宿主可写的开放字典，可能被塞进任意值；这里只接受形状正确的引用，
 * 坏数据跳过而不是让整次压缩失败。
 */
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

/**
 * 把模型的原始输出收敛成最终摘要。
 * `<analysis>` 是让模型先想后写的草稿，只用于提升摘要质量，不进上下文——留着纯属浪费 token。
 * 若模型没按约定包 `<summary>`，就退回使用整段输出，而不是判定为失败。
 */
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

/**
 * 返回头部连续 system 消息的条数，也就是**永远不参与摘要**的那一段。
 * 它们是系统提示词与宿主注入的前缀，语义上属于「这个 Agent 是谁」而不是「聊过什么」，
 * 被摘要掉等于换了个人格。
 */
function splitSystemMessages(messages: readonly RawMessage[]): number {
  for (let index = 0; index < messages.length; index += 1) {
    if (messages[index]?.role !== "system") return index;
  }
  return messages.length;
}

/**
 * 带**空闲**超时地取下一帧：超时按「距上一帧的间隔」计，而不是整段摘要的总时长——
 * 长摘要合理地要跑很久，只要还在持续吐字就不该被打断。
 *
 * 超时通过中止作用域内的 controller 生效，这样底层连接会真正被取消，
 * 而不只是我们这边不再等待。
 */
async function nextWithTimeout(
  iterator: AsyncIterator<LlmChunk>,
  signal: AbortSignal,
  timeoutMs: number,
  timeoutController: AbortController,
): Promise<IteratorResult<LlmChunk>> {
  if (signal.aborted) throw abortError(signal);
  const { promise: interrupted, reject } = Promise.withResolvers<never>();
  /** 闲置超时：中止本次流并以上限错误拒绝，让底层连接真正被取消。 */
  function rejectOnIdleTimeout(): void {
    const error = new Error(`summary stream idle for ${timeoutMs}ms`);
    timeoutController.abort(error);
    reject(error);
  }
  /** 上游取消：以取消原因拒绝。 */
  function rejectOnAbort(): void {
    reject(abortError(signal));
  }
  const timer = setTimeout(rejectOnIdleTimeout, timeoutMs);
  signal.addEventListener("abort", rejectOnAbort, { once: true });
  try {
    return await Promise.race([iterator.next(), interrupted]);
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", rejectOnAbort);
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

  /** 纯判定，不做任何副作用：压缩本身由 `compress` 完成，主循环在两次调用之间还有别的取舍。 */
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
    // 尾部要保住的不只是 keepRecent 条历史，还包括 context.messages 里当前这一轮正在处理的消息：
    // 它们马上要被送给模型，此刻摘要掉等于把刚发生的事立刻忘掉。
    const tailCount = Math.min(
      messages.length - historyStart,
      context.messages.length + keepRecent,
    );
    // 切割点必须落在消息组的边界上。assistant(tool_calls) 与紧随其后的 tool 结果是一组，
    // 从中间切开会让尾部以一个孤立的 tool 结果开头（或让被摘要的部分以悬空的 tool_calls 结尾），
    // 两种形状 provider 都会直接拒绝。因此遇到这类相邻对就把切割点整体左移。
    let summarizeEnd = messages.length - tailCount;
    while (summarizeEnd > historyStart) {
      const previous = messages[summarizeEnd - 1];
      const next = messages[summarizeEnd];
      const previousHasPendingTools = (previous?.toolCalls?.length ?? 0) > 0;
      const nextIsTool = next?.role === "tool";
      if (!previousHasPendingTools && !nextIsTool) break;
      summarizeEnd -= 1;
    }
    // 一路退到没有可摘要的历史（尾部本身就撑满了窗口）就原样返回，让主循环走别的降级路径。
    if (summarizeEnd <= historyStart) return [...messages];

    // 失败要计数并向上抛：主循环据此决定降级，而计满 MAX_CONSECUTIVE_FAILURES 后
    // shouldCompact 会停止触发，避免每一轮都白等一次注定失败的摘要。
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

    // 重建顺序：保留的 system 前缀 → 分界标记 → 摘要 → 保留的尾部原文。
    // 分界标记是一条 system 消息，让模型知道「上面那段是压缩过的」，
    // 而不是把摘要误当成用户刚说的话。
    const output: RawMessage[] = [
      ...messages.slice(0, historyStart),
      buildBoundaryMessage(preTokens, summarizeEnd),
      buildSummaryMessage(summary),
      ...messages.slice(summarizeEnd),
    ];
    // 内容恢复是尽力而为：摘要本身已经有效，附件拿不到不该让整次压缩作废。
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

  /**
   * 没显式配置阈值时按模型窗口推算：窗口 − 预留输出 − 缓冲。
   * 模型没有声明 `contextWindow` 时返回 0，表示「不猜」——宁可完全不自动压缩，
   * 也不要凭一个虚构的窗口大小反复触发。
   */
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
      // 两层空判定：模型什么都没回，和回了但解析后什么都不剩，是两种不同的故障，
      // 分开报错才能在排障时看出是该调提示词还是该查解析。
      const raw = content.join("").trim();
      if (raw === "") throw new Error("summary response is empty");
      const formatted = formatCompactSummary(raw);
      if (formatted === "") throw new Error("parsed summary is empty");
      return formatted;
    } finally {
      // 无论成败都掐掉超时控制器，避免它带着计时器活过这次调用。
      timeoutController.abort(new Error("summary complete"));
    }
  }
}
