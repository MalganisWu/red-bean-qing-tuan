import type { Attribute, Span, SpanStart, Tracer } from "../port/tracer.js";

/**
 * 未配置观测后端时使用的零开销 Span。
 * `within` 仍然执行传入的操作——它只是不传播上下文，绝不能顺手把业务逻辑吞掉。
 * 有了它，调用方永远拿得到一个可用的 Tracer，不必到处判空。
 */
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
