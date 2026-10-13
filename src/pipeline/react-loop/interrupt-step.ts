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
 *
 * 三处刻意的严格：
 * - 一个批次里出现**第二个**中断请求直接判错。一批工具最多只能有一个屏障，
 *   否则「等谁确认」就没有唯一答案了。
 * - 中断的那个调用**不写 tool 消息**（`continue` 跳过）：它的结果要等宿主确认后才产生，
 *   此刻写一条空结果会让历史里出现一条永远对不上的工具调用。
 * - 工具失败不抛出，而是序列化成 `{"error": ...}` 写进 tool 消息——
 *   工具出错是模型需要读到并据此调整的**信息**，不是运行的故障。
 *
 * @param executions - 本轮的工具执行结果，顺序与调用一致；中断项不写 tool 消息。
 * @param context - 运行上下文，用于登记工具声明的内容引用。
 * @param messages - 对话消息数组，普通工具结果会追加进来。
 * @param systemOffset - 开头系统提示词的条数，用于截取可见上下文。
 * @param onMessage - 消息提交后的观察回调，省略则只入内存不对外通知。
 * @param result - 本次运行的阶段结果；失败时会被写入错误与上下文快照。
 * @returns 批次中发现的唯一中断请求；整批无中断时为 undefined。
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
    // 工具可以把大块内容「寄存」成引用而不是塞进上下文，这里统一登记到 context 上，
    // 供后续压缩后的内容恢复使用。
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
