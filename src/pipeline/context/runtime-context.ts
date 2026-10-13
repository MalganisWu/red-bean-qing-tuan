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
  /**
   * 逻辑会话 ID，跨同一会话的多轮运行保持稳定；恢复时用它定位该会话的消息与 checkpoint 命名空间，
   * 因此它不等于单次运行标识（后者由 requestId 承担）。
   */
  public readonly sessionId: string;
  /**
   * 本次运行锚定的 checkpoint ID；宿主据此定位要续跑的持久化状态，
   * 本类只读取它、不负责其存储。
   */
  public readonly checkpointId: string;
  /** 触发本次运行的用户身份，供审计与多租户隔离；其真实性由宿主保证，SDK 不校验。 */
  public readonly userId: string;
  /** 单次运行的唯一标识，每轮都不同；用于串联日志与并发去重，会话级稳定标识见 sessionId。 */
  public readonly requestId: string;
  /** 分布式追踪 ID，跨进程透明传递，把一次运行在宿主侧的多段处理串成同一条链路。 */
  public readonly traceId: string;
  /**
   * checkpoint 修订号，用于并发写保护：写入方必须携带读到的值做 CAS 比对，
   * 不匹配即说明期间已有其他写者，借此避免丢失更新。
   */
  public readonly checkpointRevision: bigint;
  /**
   * 恢复认领用的栅栏令牌，单调递增；被抢占的旧执行者持有的令牌更小，
   * 其写入会被拒绝，从而保证同一时刻只有一个执行者能推进状态。
   */
  public readonly fencingToken: bigint;
  /** 本次运行开始前已提交的历史消息快照（构造时复制）；运行中新增的消息不写回这里。 */
  public readonly messages: readonly RawMessage[];
  /**
   * 送给模型的上下文消息；运行过程会就地改写它（每轮追加），
   * 因此本实例不得跨运行复用，否则上一轮的残留会污染下一轮。
   */
  public llmContext: RawMessage[];
  /**
   * 运行期元数据容器，同样是可变状态；执行组件用它回写结果与 token 用量等归因信息，
   * 与 llmContext 一样不可跨运行复用。
   */
  public readonly metadata: Map<string, unknown>;
  /**
   * 最近一次 pipeline 执行已归集的失败；SequentialPipeline 在清理段逐步更新它，
   * 让后跑的 finally 节点能看到「目前已知的失败」。为 undefined 表示尚无可归因的失败。
   */
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

  /**
   * 返回本次运行用来索引 checkpoint 的键。目前直接复用 checkpointId，
   * 独立成方法是给「键与 ID 分离」留出替换点；返回空串表示本次运行不参与缓冲区持久化。
   *
   * @returns 本次运行的 checkpoint 键，可能为空串。
   */
  public checkpointKey(): string {
    return this.checkpointId;
  }

  /**
   * 把一条运行事件同步投递给宿主的事件接收器。未配置接收器时静默丢弃；
   * 只做同步投递，不缓冲也不重试——事件的传输与持久化归宿主。
   *
   * @param event - 要投递的运行事件；由调用方构造，本类不校验其内容。
   */
  public emit(event: RuntimeEvent): void {
    this.#eventSink?.(event);
  }
}

/**
 * 从 `ToolCallContext` 发事件；工具拿到的只有这个窄上下文，不持有整个 RuntimeContext。
 *
 * @param context - 工具侧持有的窄上下文，事件从其事件接收器发出。
 * @param event - 要投递的运行事件，由调用方构造。
 */
export function emitToolCallEvent(
  context: ToolCallContext,
  event: RuntimeEvent,
): void {
  context.eventSink?.(event);
}
