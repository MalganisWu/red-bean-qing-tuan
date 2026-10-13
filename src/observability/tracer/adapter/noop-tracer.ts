import type { Attribute, Span, SpanStart, Tracer } from "../port/tracer.js";

/**
 * 未配置观测后端时使用的零开销 Span。
 * `within` 仍然执行传入的操作——它只是不传播上下文，绝不能顺手把业务逻辑吞掉。
 * 有了它，调用方永远拿得到一个可用的 Tracer，不必到处判空。
 */
export class NoopSpan implements Span {
  /**
   * 空实现：不记录任何属性，也不产生副作用。
   *
   * @param _attributes - 被整体丢弃的 span 属性，保留形参只为满足 `Span` 契约。
   */
  public setAttributes(..._attributes: readonly Attribute[]): void {}

  /**
   * 空实现：不建立父子上下文关系，直接执行传入的操作。
   *
   * @param operation - 被原样调用并返回的操作，其异常与结果都不做包装。
   * @returns `operation` 的 Promise 本身，空实现既不吞并也不改写它的结果。
   */
  public within<TValue>(operation: () => Promise<TValue>): Promise<TValue> {
    return operation();
  }

  /**
   * 空实现：不导出任何 span，传入的结束错误被忽略。
   *
   * @param _error - 被丢弃的结束错误，保留形参只为满足 `Span` 契约。
   */
  public end(_error?: Error): void {}
}

/** 未配置观测后端时使用的默认 Tracer。 */
export class NoopTracer implements Tracer {
  /**
   * 空实现：不建立真实链路，统一返回零开销的 `NoopSpan`。
   *
   * @param _start - 被忽略的 span 起始信息，保留形参只为满足 `Tracer` 契约。
   * @returns 一个不采集数据、但可安全调用的 `NoopSpan`，使调用方无需到处判空。
   */
  public start(_start: SpanStart): Span {
    return new NoopSpan();
  }
}
