import type { RuntimeEvent } from "../../protocol/event.js";
import type { RawMessage } from "../../protocol/message.js";
import type {
  RuntimeEventSink,
  ToolCallContext,
} from "../../protocol/run-identity.js";

/** @deprecated 请从公开 Pipeline 入口使用同名类型；定义位于 protocol/run-identity。 */
export type { ToolCallContext } from "../../protocol/run-identity.js";

/** RuntimeContext 使用的同步事件回调；事件的传输与持久化仍归宿主所有。 */
export type EventSink = RuntimeEventSink;

/**
 * 创建单次 RuntimeContext 所需的完整状态快照。
 * 调用方保留输入集合的所有权；RuntimeContext 会复制可变集合，且实例不得跨运行复用。
 */
export interface RuntimeContextOptions {
  readonly sessionId: string;
  readonly checkpointId: string;
  readonly userId: string;
  readonly requestId: string;
  readonly traceId: string;
  readonly checkpointRevision: bigint;
  readonly fencingToken: bigint;
  readonly messages: readonly RawMessage[];
  readonly llmContext: readonly RawMessage[];
  readonly eventSink?: EventSink | undefined;
  readonly metadata?: ReadonlyMap<string, unknown> | undefined;
}

/**
 * 单次 pipeline 执行共享的可变状态，绝不能存入全局对象。
 *
 * 「单次」是硬约束：构造时把来参里的集合都**复制**一份（`[...]` / `new Map()`），
 * 因此调用方后续改动自己那份不会影响本次运行；反过来，这个实例也不能跨运行复用——
 * `llmContext` 与 `metadata` 都会被运行过程改写，复用等于把上一次的残留带进下一次。
 */
export class RuntimeContext {
  public readonly sessionId: string;
  public readonly checkpointId: string;
  public readonly userId: string;
  public readonly requestId: string;
  public readonly traceId: string;
  public readonly checkpointRevision: bigint;
  public readonly fencingToken: bigint;
  public readonly messages: readonly RawMessage[];
  public llmContext: RawMessage[];
  public readonly metadata: Map<string, unknown>;
  public pipelineError: Error | undefined;
  readonly #eventSink: EventSink | undefined;

  public constructor(options: RuntimeContextOptions) {
    this.sessionId = options.sessionId;
    this.checkpointId = options.checkpointId;
    this.userId = options.userId;
    this.requestId = options.requestId;
    this.traceId = options.traceId;
    this.checkpointRevision = options.checkpointRevision;
    this.fencingToken = options.fencingToken;
    this.messages = [...options.messages];
    this.llmContext = [...options.llmContext];
    this.metadata = new Map(options.metadata);
    this.#eventSink = options.eventSink;
  }

  public checkpointKey(): string {
    return this.checkpointId;
  }

  public emit(event: RuntimeEvent): void {
    this.#eventSink?.(event);
  }
}

/** 从 `ToolCallContext` 发事件；工具拿到的只有这个窄上下文，不持有整个 RuntimeContext。 */
export function emitToolCallEvent(
  context: ToolCallContext,
  event: RuntimeEvent,
): void {
  context.eventSink?.(event);
}
