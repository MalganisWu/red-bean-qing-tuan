import type { LlmRequest } from "../../llm/model/model.js";
import { EVENT_TYPES, STATUS_CODES } from "../../protocol/event.js";
import type { RawMessage } from "../../protocol/message.js";
import type { ToolCall } from "../../tool/definition/tool.js";
import { resolveLlmRunParams } from "./llm-retry.js";
import { assembleToolCalls } from "./tool-call-buffer.js";
import { DefaultCompressor } from "../compression/service/default-context-compressor.js";
import {
  dispatchToolBatch,
  immutableToolCallBuffer,
  isolateInterruptingToolCall,
  type ToolExecution,
} from "./tool-step.js";
import {
  abortLoopError,
  copyVisibleContext,
  failReactLoop,
  normalizeLoopError,
  persistLoopMessage,
  type ReactResult,
  type RunReactLoopOptions,
} from "./loop-state.js";
import { executeModelTurn } from "./model-turn.js";
import { applyToolExecutionResults } from "./interrupt-step.js";

export {
  ReactLoopError,
  type MessageObserver,
  type ReactResult,
  type RunReactLoopOptions,
} from "./loop-state.js";

/** `RuntimeContext.metadata` 中存放本次挂起的工具调用 ID 的键。 */
export const INTERRUPT_CALL_ID_METADATA_KEY = "interrupt_call_id";
/** `RuntimeContext.metadata` 中存放完整 `Interrupt` 的键；上层据此构造挂起结果。 */
export const INTERRUPT_METADATA_KEY = "interrupt";

/** 没有配置 maxToolIterations 时的轮次上限，防止模型陷入工具调用死循环时耗尽预算。 */
const DEFAULT_MAX_TOOL_ITERATIONS = 30;

/**
 * ReAct 主循环：准备上下文 → 模型流 → 写回 assistant 消息 → 执行工具批次 → 合并结果，
 * 直到模型不再请求工具、命中轮次上限、被取消，或在 interrupt 屏障处挂起。
 *
 * 循环的每一次迭代恰好产生一轮「模型 → 工具」往返。中断是**执行屏障**：
 * 一批工具里只要有任意一个要求人工确认，这一批的其他工具都不会执行——
 * 合并结果时会把中断识别出来并让整个运行进入挂起态，而不是只跳过那一个调用。
 * 挂起状态通过 `context.metadata` 传给上层，`stopReason` 为 `awaiting_user`。
 *
 * @param options - 主循环的全部依赖与本次运行状态，字段见 `RunReactLoopOptions`。
 * @returns 循环终止时的完整状态；`stopReason` 区分正常结束、轮次用尽与等待确认，
 *   而失败或取消一律抛出 `ReactLoopError` 而非正常返回。
 */
export async function runReactLoop(
  options: RunReactLoopOptions,
): Promise<ReactResult> {
  if (!options.context) throw new Error("pipeline context must be configured");
  if (
    !options.adapter ||
    typeof options.adapter.streamCompletion !== "function"
  ) {
    throw new Error("LLM adapter must be configured");
  }
  const {
    context,
    adapter,
    dispatcher,
    tools,
    onMessage,
    systemPrompt,
    modelParams,
    config,
    signal,
  } = options;
  // 同一 context 可能被复用（例如挂起后恢复），先把上一轮遗留的中断痕迹清掉，
  // 否则一次失败的恢复会让后续运行带着一个早已失效的 interrupt 启动。
  context.metadata.delete(INTERRUPT_CALL_ID_METADATA_KEY);
  context.metadata.delete(INTERRUPT_METADATA_KEY);

  let systemOffset = 0;
  const messages: RawMessage[] = [];
  if (systemPrompt !== "") {
    systemOffset = 1;
    messages.push({ role: "system", content: systemPrompt });
  }
  // systemPrompt 每轮都由配置重新注入，而 llmContext 里可能已经存着一份（恢复场景）。
  // 这里把历史开头那份同样的 system 消息去掉再拼接，避免提示词出现两次。
  let history = [...context.llmContext];
  while (
    systemPrompt !== "" &&
    history[0]?.role === "system" &&
    history[0].content === systemPrompt
  ) {
    history = history.slice(1);
  }
  messages.push(...history, ...context.messages);

  // llmContext 始终不含系统提示词（见 copyVisibleContext）：它由配置持有，
  // 存进历史只会带来「更新提示词后旧副本还在」的问题。
  const result: ReactResult = {
    llmContext: copyVisibleContext(messages, systemOffset),
    tokensUsed: 0,
    finishReason: "",
    cancelled: false,
    stopReason: "",
  };
  const configuredIterations = config.maxToolIterations;
  const maxIterations =
    configuredIterations !== undefined &&
    Number.isSafeInteger(configuredIterations)
      ? Math.max(0, configuredIterations)
      : DEFAULT_MAX_TOOL_ITERATIONS;
  const llmParams = resolveLlmRunParams(config);
  let compressor = config.compression?.compressor;
  if (!compressor && config.compression?.enabled === true) {
    compressor = new DefaultCompressor(
      adapter,
      config.compression,
      modelParams,
    );
  }

  for (let iteration = 0; iteration < maxIterations; iteration += 1) {
    if (signal.aborted) {
      result.cancelled = true;
      failReactLoop(
        result,
        abortLoopError(signal).message,
        abortLoopError(signal),
      );
    }
    context.emit({
      type: EVENT_TYPES.STATUS,
      code:
        iteration === 0
          ? STATUS_CODES.THINKING
          : STATUS_CODES.ANALYZING_RESULTS,
    });

    // 阶段一：准备模型上下文；压缩只是尽力优化，失败时继续使用原始消息。
    if (compressor) {
      try {
        if (await compressor.shouldCompact(context, messages, signal)) {
          const compacted = await compressor.compress(
            context,
            messages,
            signal,
          );
          messages.splice(0, messages.length, ...compacted);
        }
      } catch {
        // 压缩是可选的尽力优化，失败不应破坏主流程。
      }
    }

    const request: LlmRequest = {
      messages: [...messages],
      tools: [...tools],
      params: modelParams,
    };
    // 阶段二：执行一次模型流，空响应重试与 iterator 关闭由 model-turn 负责。
    const modelTurn = await executeModelTurn({
      adapter,
      request,
      context,
      iteration,
      llmParams,
      messages,
      systemOffset,
      result,
      onMessage,
      signal,
    });
    const { contentParts, toolBuffer } = modelTurn;
    result.finishReason = modelTurn.finishReason;
    // 阶段三：模型没有请求工具时，提交 assistant 消息并结束本次运行。
    if (toolBuffer.size === 0) {
      const assistantMessage: RawMessage = {
        role: "assistant",
        content: contentParts.join(""),
      };
      try {
        await persistLoopMessage(messages, assistantMessage, onMessage);
      } catch (value: unknown) {
        result.llmContext = copyVisibleContext(messages, systemOffset);
        const error = normalizeLoopError(value);
        failReactLoop(result, error.message, error);
      }
      result.llmContext = copyVisibleContext(messages, systemOffset);
      return result;
    }

    let toolCalls: readonly ToolCall[];
    try {
      toolCalls = isolateInterruptingToolCall(
        tools,
        assembleToolCalls(immutableToolCallBuffer(toolBuffer)),
      );
    } catch (value: unknown) {
      const error = normalizeLoopError(value);
      failReactLoop(result, error.message, error);
    }
    const assistantMessage: RawMessage = {
      role: "assistant",
      content: contentParts.length === 0 ? null : contentParts.join(""),
      toolCalls,
    };
    try {
      await persistLoopMessage(messages, assistantMessage, onMessage);
    } catch (value: unknown) {
      result.llmContext = copyVisibleContext(messages, systemOffset);
      const error = normalizeLoopError(value);
      failReactLoop(result, error.message, error);
    }

    // 阶段四：执行工具批次；interrupt 工具已经在分发前被隔离为屏障。
    let executions: readonly ToolExecution[];
    try {
      executions = await dispatchToolBatch(
        toolCalls,
        context,
        dispatcher,
        tools,
        config,
        signal,
      );
    } catch (value: unknown) {
      if (signal.aborted) result.cancelled = true;
      result.llmContext = copyVisibleContext(messages, systemOffset);
      const error = normalizeLoopError(value);
      failReactLoop(result, error.message, error);
    }

    // 阶段五：把普通工具结果写回上下文，或识别中断屏障等待宿主恢复。
    const interrupt = await applyToolExecutionResults(
      executions,
      context,
      messages,
      systemOffset,
      onMessage,
      result,
    );

    if (interrupt) {
      context.metadata.set(
        INTERRUPT_CALL_ID_METADATA_KEY,
        interrupt.toolCallId,
      );
      context.metadata.set(INTERRUPT_METADATA_KEY, interrupt);
      result.interrupt = interrupt;
      result.stopReason = "awaiting_user";
      result.llmContext = copyVisibleContext(messages, systemOffset);
      return result;
    }
  }

  result.stopReason = "max_iterations";
  result.llmContext = copyVisibleContext(messages, systemOffset);
  return result;
}
