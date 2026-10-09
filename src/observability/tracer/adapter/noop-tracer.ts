import type { Attribute, Span, SpanStart, Tracer } from "../port/tracer.js";

/** 未配置观测后端时使用的零开销 Span。 */
export class NoopSpan implements Span {
  public setAttributes(..._attributes: readonly Attribute[]): void {}

  public within<TValue>(operation: () => Promise<TValue>): Promise<TValue> {
    return operation();
  }

  public end(_error?: Error): void {}
}

/** 未配置观测后端时使用的默认 Tracer。 */
export class NoopTracer implements Tracer {
  public start(_start: SpanStart): Span {
    return new NoopSpan();
  }
}
