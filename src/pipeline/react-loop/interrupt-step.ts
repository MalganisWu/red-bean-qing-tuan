import {
  SIGNAL_KINDS,
  type Interrupt,
  type Signal,
} from "../../protocol/interrupt.js";
import type { RawMessage } from "../../protocol/message.js";
import type { RuntimeContext } from "../context/runtime-context.js";
import {
  copyVisibleContext,
  failReactLoop,
  normalizeLoopError,
  persistLoopMessage,
  type MessageObserver,
  type ReactResult,
} from "./loop-state.js";
import {
  appendContentRef,
  parseInterruptArguments,
  type ToolExecution,
} from "./tool-step.js";

/**
 * 合并一轮工具执行结果并识别 interrupt 屏障。
 * 普通结果先持久化为 tool 消息；interrupt 只返回中性结构，由主循环统一进入挂起终态。
 */
export async function applyToolExecutionResults(
  executions: readonly ToolExecution[],
  context: RuntimeContext,
  messages: RawMessage[],
  systemOffset: number,
  onMessage: MessageObserver | undefined,
  result: ReactResult,
): Promise<Interrupt | undefined> {
  let interrupt: Interrupt | undefined;
  for (const execution of executions) {
    if (execution.result.preserve) {
      appendContentRef(context, execution.result.preserve);
    }
    const engineSignal: Signal | undefined = execution.result.signal;
    if (engineSignal) {
      if (engineSignal.kind !== SIGNAL_KINDS.INTERRUPT) {
        failReactLoop(result, "unknown engine signal kind");
      }
      if (interrupt) {
        failReactLoop(result, "multiple interrupting tool calls in one batch");
      }
      interrupt = {
        toolCallId: execution.call.id,
        toolName: execution.call.function.name,
        arguments: parseInterruptArguments(execution.call.function.arguments),
        payload: engineSignal.payload,
      };
      continue;
    }

    const toolMessage: RawMessage = {
      role: "tool",
      content: execution.error
        ? JSON.stringify({ error: execution.error.message })
        : execution.result.content,
      toolCallId: execution.call.id,
    };
    try {
      await persistLoopMessage(messages, toolMessage, onMessage);
    } catch (value: unknown) {
      result.llmContext = copyVisibleContext(messages, systemOffset);
      const error = normalizeLoopError(value);
      failReactLoop(result, error.message, error);
    }
  }
  return interrupt;
}
