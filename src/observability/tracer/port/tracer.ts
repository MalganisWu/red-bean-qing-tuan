/** Runtime 中性的 Trace 属性。 */
export interface Attribute {
  readonly key: string;
  readonly value: string;
}

/** 启动 Span 所需的低基数属性。 */
export interface SpanStart {
  readonly name: string;
  readonly attributes: readonly Attribute[];
}

/** 宿主 Span 的最小生命周期；end 必须可由失败路径调用。 */
export interface Span {
  setAttributes(...attributes: readonly Attribute[]): void;
  within<TValue>(operation: () => Promise<TValue>): Promise<TValue>;
  end(error?: Error): void;
}

/**
 * 中性观测 Port。SDK 提供 NoopTracer；宿主需要观测时显式构造 RuntimeTracePlugin 并注入自己的实现。
 */
export interface Tracer {
  start(start: SpanStart): Span;
}
