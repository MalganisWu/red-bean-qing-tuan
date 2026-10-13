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
import { abortError } from "../../../protocol/abort-signal.js";

/** 统一 Agent 执行组件的依赖集合；所有依赖均由高层 Runtime 或 AgentNode 显式注入。 */
export interface ReactAgentExecutionOptions {
  /** LLM 适配器，主循环用它发起模型流。 */
  readonly adapter: LlmAdapter;
  /** 工具分发器，主循环用它真正执行工具调用。 */
  readonly dispatcher: ToolDispatcher;
  /** 本轮可用工具声明；同时决定哪些调用具备中断屏障。 */
  readonly tools: readonly ToolSchema[];
  /** 消息 Hook，可选；未配置时不组装消息观察回调，消息提交后不对外通知。 */
  readonly hook?: MessageHook | undefined;
  /** 注入循环开头的系统提示词；执行结束时会被剥离，不写回可见上下文。 */
  readonly systemPrompt: string;
  /** 模型参数，透传给每次模型调用。 */
  readonly modelParams: ModelParams;
  /** 运行预算与重试配置，决定轮次上限、超时与压缩策略。 */
  readonly config: RuntimeConfig;
  /** 中断投影器，可选；未配置时中断只写回元数据、不交给宿主展示。 */
  readonly interruptAssembler?: InterruptAssembler | undefined;
}

/**
 * 高层 AgentRuntime 与低层 AgentNode 共用的唯一 ReAct 执行组件。
 * 它只协调中性 RuntimeContext、消息 Hook 与 interrupt，不负责 checkpoint 或宿主持久化。
 */
export class ReactAgentExecution implements AgentExecution {
  /** 构造时注入的依赖与配置；本类只读取，不做改写。 */
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
   *
   * @param context - 本次运行的共享状态；执行过程中会改写其 llmContext 与 metadata。
   * @param signal - 取消信号；已中止时直接抛 abort 错误，不再发起模型调用。
   * @returns 本次 ReAct 的中性结果；失败时改为抛出 ReactAgentExecutionError。
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

/**
 * 把消息 Hook 适配成主循环需要的消息观察回调。
 *
 * 按消息角色分派到对应的 Hook 方法；每条消息都经由 `runHook` 统一错误语义——
 * 只有 fatal hook 错误才中断主流程，普通错误被吞掉放行。
 *
 * @param context - 本次运行上下文，原样传给每个 Hook。
 * @param hook - 要适配的消息 Hook。
 * @param signal - 运行取消信号，原样传给每个 Hook。
 * @returns 供主循环逐条调用的观察函数。
 */
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

/**
 * 统一消息 Hook 的失败语义：只有 `HookFatalError` 会被重新抛出，其余错误一律吞掉放行。
 *
 * 「失败是否致命」由 Hook 作者用 `HookFatalError` 显式标记，框架不代为推断。
 *
 * @param operation - 要执行的 Hook 操作；其抛出的非致命错误会被吞掉。
 */
async function runHook(operation: () => Promise<void>): Promise<void> {
  try {
    await operation();
  } catch (value: unknown) {
    if (isHookFatalError(value)) throw value;
  }
}

/**
 * 把失败归类成稳定的停止原因。
 *
 * 判定顺序是有意为之：取消优先于 fatal hook，最后才退到 LLM 错误。
 * 信号已中止或结果已在取消态都算取消；只有确认是 fatal hook 链才归为 hook_fatal。
 *
 * @param error - 已归一化的失败对象，用于沿 cause 链判断是否为 fatal hook 错误。
 * @param result - 失败那一刻的循环结果；为 undefined 表示连部分结果都没拿到。
 * @param signal - 运行取消信号。
 * @returns 与 `AgentResult.reason` 同域的原因取值。
 */
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
 *
 * @param value - 待判定的抛出物；非 Error 或链上不含 fatal 错误时返回 false。
 * @returns 该值或其 cause 链上是否存在 `HookFatalError` 实例。
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
/**
 * 把任意抛出物统一成 Error；非 Error 只做字符串化，不做结构探测。
 *
 * @param value - 任意抛出物；是 Error 时原样返回，否则被包成消息为 `String(value)` 的新 Error。
 * @returns 一定是 Error 实例。
 */
function normalizeError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}
