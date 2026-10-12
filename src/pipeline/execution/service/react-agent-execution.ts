import type { RuntimeConfig } from "../../config/runtime-config.js";
import type { LlmAdapter } from "../../../llm/adapter/port/llm-adapter.js";
import type { ModelParams } from "../../../llm/model/model.js";
import {
  AGENT_RESULT_METADATA_KEY,
  AGENT_RESULT_REASONS,
  TOKENS_USED_METADATA_KEY,
  type AgentResultReason,
} from "../agent-result.js";
import type { RuntimeContext } from "../../context/runtime-context.js";
import type { AgentExecution } from "../port/agent-execution.js";
import { ReactAgentExecutionError } from "../agent-execution-error.js";
export { ReactAgentExecutionError } from "../agent-execution-error.js";
import { isHookFatalError } from "../../hook/hook-error.js";
import type { MessageHook } from "../../hook/port/message-hook.js";
import type { InterruptAssembler } from "../../interrupt/port/interrupt-assembler.js";
import type { RawMessage } from "../../../protocol/message.js";
import type { ToolSchema } from "../../../protocol/tool-schema.js";
import type { ToolDispatcher } from "../../../tool/dispatcher/port/tool-dispatcher.js";
import {
  ReactLoopError,
  runReactLoop,
  type MessageObserver,
  type ReactResult,
} from "../../react-loop/react-loop.js";

/** 统一 Agent 执行组件的依赖集合；所有依赖均由高层 Runtime 或 AgentNode 显式注入。 */
export interface ReactAgentExecutionOptions {
  readonly adapter: LlmAdapter;
  readonly dispatcher: ToolDispatcher;
  readonly tools: readonly ToolSchema[];
  readonly hook?: MessageHook | undefined;
  readonly systemPrompt: string;
  readonly modelParams: ModelParams;
  readonly config: RuntimeConfig;
  readonly interruptAssembler?: InterruptAssembler | undefined;
}

/**
 * 高层 AgentRuntime 与低层 AgentNode 共用的唯一 ReAct 执行组件。
 * 它只协调中性 RuntimeContext、消息 Hook 与 interrupt，不负责 checkpoint 或宿主持久化。
 */
export class ReactAgentExecution implements AgentExecution {
  readonly #options: ReactAgentExecutionOptions;

  public constructor(options: ReactAgentExecutionOptions) {
    this.#options = options;
  }

  /**
   * 跑一次 ReAct 并把结果写回上下文元数据。
   *
   * 三处结构值得注意：
   * - **先回放已有消息给 observer**：`context.messages` 是本次运行开始前就存在的历史，
   *   宿主 hook 需要先看到它们才能正确判断「哪些是新的」。
   * - **失败也要留住部分结果**：`ReactLoopError` 带着出事那一刻的 `llmContext` 与 tokensUsed，
   *   这里把它们写回 context，让上层还能持久化已经产生的进展。
   * - **`finally` 里写元数据**：无论成功、失败还是抛出，`success`/`reason`/`tokensUsed`
   *   都必须在 context 上可见。写成 try 内的一步会让失败路径完全没有归因信息。
   */
  public async execute(
    context: RuntimeContext,
    signal: AbortSignal,
  ): Promise<ReactResult> {
    let result: ReactResult | undefined;
    let success = true;
    let reason: AgentResultReason = AGENT_RESULT_REASONS.COMPLETED;
    let tokensUsed = 0;

    try {
      const observer = this.#options.hook
        ? messageObserver(context, this.#options.hook, signal)
        : undefined;
      if (observer) {
        for (const message of context.messages) await observer(message);
      }
      if (signal.aborted) {
        success = false;
        reason = AGENT_RESULT_REASONS.CANCELLED;
        throw abortError(signal);
      }

      try {
        result = await runReactLoop({
          context,
          adapter: this.#options.adapter,
          dispatcher: this.#options.dispatcher,
          tools: this.#options.tools,
          onMessage: observer,
          systemPrompt: this.#options.systemPrompt,
          modelParams: this.#options.modelParams,
          config: this.#options.config,
          signal,
        });
      } catch (value: unknown) {
        const error = normalizeError(value);
        const partial =
          value instanceof ReactLoopError ? value.result : undefined;
        if (partial && partial.llmContext.length > 0)
          context.llmContext = [...partial.llmContext];
        tokensUsed = partial?.tokensUsed ?? 0;
        success = false;
        reason = reasonForError(error, partial, signal);
        throw new ReactAgentExecutionError(
          `ReAct loop failed: ${error.message}`,
          partial,
          value,
        );
      }

      context.llmContext = [...result.llmContext];
      tokensUsed = result.tokensUsed;
      if (result.cancelled) {
        success = false;
        reason = AGENT_RESULT_REASONS.CANCELLED;
      } else if (result.interrupt) {
        if (this.#options.interruptAssembler) {
          try {
            await this.#options.interruptAssembler.assemble(
              context,
              result.interrupt,
            );
          } catch (value: unknown) {
            success = false;
            reason = AGENT_RESULT_REASONS.LLM_ERROR;
            throw new ReactAgentExecutionError(
              `assemble interrupt failed: ${normalizeError(value).message}`,
              result,
              value,
            );
          }
        }
        reason = AGENT_RESULT_REASONS.AWAITING_USER;
      } else if (result.stopReason !== "") {
        success = false;
        reason = AGENT_RESULT_REASONS.MAX_ITERATIONS;
      }
      return result;
    } catch (value: unknown) {
      if (isHookFatalErrorChain(value)) {
        success = false;
        reason = AGENT_RESULT_REASONS.HOOK_FATAL;
      }
      throw value;
    } finally {
      context.metadata.set(AGENT_RESULT_METADATA_KEY, { success, reason });
      context.metadata.set(TOKENS_USED_METADATA_KEY, tokensUsed);
    }
  }
}

function messageObserver(
  context: RuntimeContext,
  hook: MessageHook,
  signal: AbortSignal,
): MessageObserver {
  /** 按角色把消息派发给 hook；runHook 只负责统一错误语义。 */
  async function dispatchMessage(message: RawMessage): Promise<void> {
    switch (message.role) {
      case "user":
        await hook.onUserMessage(context, message, signal);
        return;
      case "assistant":
        await hook.onAssistantMessage(context, message, signal);
        return;
      case "tool":
        await hook.onToolMessage(context, message, signal);
    }
  }

  /** 观察出口：每条已提交消息都经由 runHook 进入 hook，避免 hook 抛错打断主流程。 */
  async function observeMessage(message: RawMessage): Promise<void> {
    await runHook(async (): Promise<void> => dispatchMessage(message));
  }

  return observeMessage;
}

async function runHook(operation: () => Promise<void>): Promise<void> {
  try {
    await operation();
  } catch (value: unknown) {
    if (isHookFatalError(value)) throw value;
  }
}

function reasonForError(
  error: Error,
  result: ReactResult | undefined,
  signal: AbortSignal,
): AgentResultReason {
  if (result?.cancelled === true || signal.aborted)
    return AGENT_RESULT_REASONS.CANCELLED;
  if (isHookFatalErrorChain(error)) return AGENT_RESULT_REASONS.HOOK_FATAL;
  return AGENT_RESULT_REASONS.LLM_ERROR;
}

/**
 * 沿 `cause` 链找 fatal hook 错误。
 *
 * 必须遍历整条链：真正的 fatal 错误往往被中间层包了一层（例如被包进 ReactAgentExecutionError），
 * 只看最外层会漏判。`visited` 集合防的是 cause 链成环——出错路径上什么都可能发生，
 * 一个自引用会让这里变成死循环。
 */
function isHookFatalErrorChain(value: unknown): boolean {
  let current: unknown = value;
  const visited = new Set<unknown>();
  while (current instanceof Error && !visited.has(current)) {
    const cause: unknown = current.cause;
    if (isHookFatalError(current)) return true;
    visited.add(current);
    current = cause;
  }
  return false;
}

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new DOMException("operation aborted", "AbortError");
}

function normalizeError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}
