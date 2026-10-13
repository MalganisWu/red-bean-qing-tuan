import type { ToolCall } from "../../../protocol/tool-call.js";
import type { ToolCallContext } from "../../../protocol/run-identity.js";
import type { ToolResult } from "../../definition/tool.js";

/**
 * 工具调用分发 Port；具体授权、隔离和执行策略由实现或宿主提供。
 * SDK 默认使用 MapToolDispatcher 或拒绝式 NoopToolDispatcher，由 runtime-composition.ts 显式组装。
 */
export interface ToolDispatcher {
  /**
   * 分发一次工具调用。
   *
   * 失败语义：工具未注册或参数非法时以被拒绝的 Promise 表示（见 `ToolDispatchError` 的错误码），
   * 组合分发器靠错误码而非消息文本决定是否换下一张表。
   *
   * @param call - 模型给出的工具调用；实现按 `function.name` 解析并查表。
   * @param context - 调用身份与并发令牌，须透传给目标工具。
   * @param signal - 取消信号，须透传给目标工具。
   * @returns 工具执行结果；分发阶段失败时以 `ToolDispatchError` 拒绝。
   */
  dispatch(
    call: ToolCall,
    context: ToolCallContext,
    signal: AbortSignal,
  ): Promise<ToolResult>;
}
