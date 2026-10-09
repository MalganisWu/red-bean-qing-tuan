import type { ToolCall } from "../../../protocol/tool-call.js";
import type { ToolCallContext } from "../../../protocol/run-identity.js";
import type { ToolResult } from "../../definition/tool.js";

/**
 * 工具调用分发 Port；具体授权、隔离和执行策略由实现或宿主提供。
 * SDK 默认使用 MapToolDispatcher 或拒绝式 NoopToolDispatcher，由 runtime-composition.ts 显式组装。
 */
export interface ToolDispatcher {
  dispatch(
    call: ToolCall,
    context: ToolCallContext,
    signal: AbortSignal,
  ): Promise<ToolResult>;
}
