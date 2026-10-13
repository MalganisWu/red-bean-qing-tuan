import type { RuntimeEvent } from "./event.js";

/**
 * 一次 Runtime 调用在日志、事件和工具边界共享的稳定身份。
 * 宿主负责生成这些标识；SDK 只负责原样传递，不能在子能力中重新生成。
 */
export interface RunIdentity {
  /** 会话级标识，把同一会话的多次请求串成一条线程。 */
  readonly threadId: string;
  /** 发起方用户标识，用于归属与鉴权；由宿主提供，SDK 不解释其含义。 */
  readonly userId: string;
  /** 单次请求标识，在重试之间保持不变，用于幂等与去重。 */
  readonly requestId: string;
  /** 跨服务追踪标识，用于把日志与事件关联到同一次调用链。 */
  readonly traceId: string;
}

/** Runtime 事件的同步出口；传输、缓冲和持久化策略由宿主决定。 */
export type RuntimeEventSink = (event: RuntimeEvent) => void;

/**
 * 工具调用获得的只读执行身份与并发令牌。
 * 工具不得借此修改父运行状态；revision 与 fencing token 只用于关联和幂等控制。
 */
export interface ToolCallContext extends RunIdentity {
  /** 本次工具调用标识，在父运行内唯一，用于把结果回写与调用配对。 */
  readonly callId: string;
  /** 工具读到的 checkpoint 版本号；用于让写入方判断读后是否有他人推进。 */
  readonly checkpointRevision: bigint;
  /** 并发围栏令牌；写入方须回报该值，租约持有者更替后旧令牌的写入会被拒绝。 */
  readonly fencingToken: bigint;
  /** 事件出口；未设置表示本次调用不发出中性事件。 */
  readonly eventSink?: RuntimeEventSink | undefined;
}
