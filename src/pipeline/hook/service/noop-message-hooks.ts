import type { RuntimeContext } from "../../context/runtime-context.js";
import type { RuntimeNode } from "../../node/port/runtime-node.js";
import type { RawMessage } from "../../../protocol/message.js";
import type { MessageHook, PipelineHook } from "../port/message-hook.js";

/** 未配置消息扩展时使用的显式空实现。 */
export class NoopMessageHook implements MessageHook {
  public onUserMessage(
    _context: RuntimeContext,
    _message: RawMessage,
    _signal: AbortSignal,
  ): Promise<void> {
    return Promise.resolve();
  }

  public onAssistantMessage(
    _context: RuntimeContext,
    _message: RawMessage,
    _signal: AbortSignal,
  ): Promise<void> {
    return Promise.resolve();
  }

  public onToolMessage(
    _context: RuntimeContext,
    _message: RawMessage,
    _signal: AbortSignal,
  ): Promise<void> {
    return Promise.resolve();
  }
}

/** 未配置 Pipeline Hook 时使用的显式空实现。 */
export class NoopPipelineHook implements PipelineHook {
  public beforeNode(
    _context: RuntimeContext,
    _node: RuntimeNode,
    _signal: AbortSignal,
  ): Promise<void> {
    return Promise.resolve();
  }

  public afterNode(
    _context: RuntimeContext,
    _node: RuntimeNode,
    _error: Error | undefined,
    _signal: AbortSignal,
  ): Promise<void> {
    return Promise.resolve();
  }

  public onPipelineStart(
    _context: RuntimeContext,
    _signal: AbortSignal,
  ): Promise<void> {
    return Promise.resolve();
  }

  public onPipelineEnd(
    _context: RuntimeContext,
    _error: Error | undefined,
    _signal: AbortSignal,
  ): Promise<void> {
    return Promise.resolve();
  }
}
