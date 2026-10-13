import type { RuntimeContext } from "../../context/runtime-context.js";
import type { RuntimeNode } from "../../node/port/runtime-node.js";
import type { RawMessage } from "../../../protocol/message.js";
import type { MessageHook, PipelineHook } from "../port/message-hook.js";

/** 未配置消息扩展时使用的显式空实现。 */
export class NoopMessageHook implements MessageHook {
  /**
   * 空实现：丢弃 user 消息，立即完成。
   *
   * @param _context - 契约占位，未使用。
   * @param _message - 契约占位，未使用。
   * @param _signal - 契约占位，未使用。
   */
  public onUserMessage(
    _context: RuntimeContext,
    _message: RawMessage,
    _signal: AbortSignal,
  ): Promise<void> {
    return Promise.resolve();
  }

  /**
   * 空实现：丢弃 assistant 消息，立即完成。
   *
   * @param _context - 契约占位，未使用。
   * @param _message - 契约占位，未使用。
   * @param _signal - 契约占位，未使用。
   */
  public onAssistantMessage(
    _context: RuntimeContext,
    _message: RawMessage,
    _signal: AbortSignal,
  ): Promise<void> {
    return Promise.resolve();
  }

  /**
   * 空实现：丢弃 tool 消息，立即完成。
   *
   * @param _context - 契约占位，未使用。
   * @param _message - 契约占位，未使用。
   * @param _signal - 契约占位，未使用。
   */
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
  /**
   * 空实现：节点执行前不做任何事，立即完成。
   *
   * @param _context - 契约占位，未使用。
   * @param _node - 契约占位，未使用。
   * @param _signal - 契约占位，未使用。
   */
  public beforeNode(
    _context: RuntimeContext,
    _node: RuntimeNode,
    _signal: AbortSignal,
  ): Promise<void> {
    return Promise.resolve();
  }

  /**
   * 空实现：节点执行后不做任何事，立即完成。
   *
   * @param _context - 契约占位，未使用。
   * @param _node - 契约占位，未使用。
   * @param _error - 契约占位，未使用。
   * @param _signal - 契约占位，未使用。
   */
  public afterNode(
    _context: RuntimeContext,
    _node: RuntimeNode,
    _error: Error | undefined,
    _signal: AbortSignal,
  ): Promise<void> {
    return Promise.resolve();
  }

  /**
   * 空实现：pipeline 启动时不做任何事，立即完成。
   *
   * @param _context - 契约占位，未使用。
   * @param _signal - 契约占位，未使用。
   */
  public onPipelineStart(
    _context: RuntimeContext,
    _signal: AbortSignal,
  ): Promise<void> {
    return Promise.resolve();
  }

  /**
   * 空实现：pipeline 结束时不做任何事，立即完成。
   *
   * @param _context - 契约占位，未使用。
   * @param _error - 契约占位，未使用。
   * @param _signal - 契约占位，未使用。
   */
  public onPipelineEnd(
    _context: RuntimeContext,
    _error: Error | undefined,
    _signal: AbortSignal,
  ): Promise<void> {
    return Promise.resolve();
  }
}
