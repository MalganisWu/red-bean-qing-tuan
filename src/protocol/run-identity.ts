import type { RuntimeEvent } from "./event.js";

/**
 * 一次 Runtime 调用在日志、事件和工具边界共享的稳定身份。
 * 宿主负责生成这些标识；SDK 只负责原样传递，不能在子能力中重新生成。
 */
export interface RunIdentity {
  readonly threadId: string;
  readonly userId: string;
  readonly requestId: string;
  readonly traceId: string;
}

/** Runtime 事件的同步出口；传输、缓冲和持久化策略由宿主决定。 */
export type RuntimeEventSink = (event: RuntimeEvent) => void;

/**
 * 工具调用获得的只读执行身份与并发令牌。
 * 工具不得借此修改父运行状态；revision 与 fencing token 只用于关联和幂等控制。
 */
export interface ToolCallContext extends RunIdentity {
  readonly callId: string;
  readonly checkpointRevision: bigint;
  readonly fencingToken: bigint;
  readonly eventSink?: RuntimeEventSink | undefined;
}
