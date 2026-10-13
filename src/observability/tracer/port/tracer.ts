/** Runtime 中性的 Trace 属性。 */
export interface Attribute {
  /** 属性名；约定使用低基数键（如 `agent.id`），高基数键会撑爆后端索引。 */
  readonly key: string;
  /** 属性值；当前只承载字符串，数值与布尔由调用方自行格式化。 */
  readonly value: string;
}

/** 启动 Span 所需的低基数属性。 */
export interface SpanStart {
  /** Span 名称，标识被观测的操作；同样是低基数维度。 */
  readonly name: string;
  /** 启动时即已知的属性；中途才能确定的属性留给 `setAttributes`。 */
  readonly attributes: readonly Attribute[];
}

/** 宿主 Span 的最小生命周期；end 必须可由失败路径调用。 */
export interface Span {
  /**
   * 补充属性到已开始的 Span。
   *
   * @param attributes - 追加的属性；同名键的覆盖行为由宿主实现决定，Port 不做约定。
   */
  setAttributes(...attributes: readonly Attribute[]): void;
  /**
   * 在活跃 Span 内执行操作，使其内部产生的 span 成为子节点。
   *
   * @param operation - 在 Span 作用域内执行的操作；其返回值原样透传。
   * @returns 操作的返回值；操作抛错时同样在 span 内结束再抛出，保证父节点被正确关闭。
   */
  within<TValue>(operation: () => Promise<TValue>): Promise<TValue>;
  /**
   * 结束 Span；失败路径也必须能调用，因此实现不得依赖「只结束一次」的断言。
   *
   * @param error - 导致结束的错误；不传表示成功结束。
   */
  end(error?: Error): void;
}

/**
 * 中性观测 Port。SDK 提供 NoopTracer；宿主需要观测时显式构造 RuntimeTracePlugin 并注入自己的实现。
 */
export interface Tracer {
  /**
   * 开始一个新的 Span。
   *
   * @param start - Span 名称与启动属性。
   * @returns 已开始的 Span；调用方负责在完成后调用其 `end`。
   */
  start(start: SpanStart): Span;
}
