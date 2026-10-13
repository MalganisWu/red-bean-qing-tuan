import type { ContentRef } from "../../protocol/content-reference.js";
import type { Signal } from "../../protocol/interrupt.js";
import type { JsonValue } from "../../protocol/json.js";
import type { ToolCallContext } from "../../protocol/run-identity.js";
import type { ToolSchema } from "../../protocol/tool-schema.js";

export type { ToolCallContext } from "../../protocol/run-identity.js";
export type { ToolCall, ToolCallFunction } from "../../protocol/tool-call.js";
export type {
  LlmToolSchema,
  ToolFunction,
  ToolSchema,
} from "../../protocol/tool-schema.js";
/**
 * 工具执行的中性结果；可附带控制信号或需要 checkpoint 保留的内容引用。
 *
 * 三个字段承担三种语义，通常只用其一：
 * - `content`：给模型看的正文，永远存在（哪怕是空串）。
 * - `signal`：控制信号。设置 `interrupt` 表示「这个工具要求挂起」，此时本次不会产生正文结果。
 * - `preserve`：大块内容的引用。工具可以不把全文塞进 `content`，而是登记一份引用，
 *   由宿主决定何时取回——压缩后的内容恢复靠它。
 */
export interface ToolResult {
  /** 给模型看的正文；永远存在，哪怕只是空串，保证消费侧无需判空。 */
  readonly content: string;
  /** 控制信号；设置 `interrupt` 表示要求挂起，此时本次不产生正文结果。 */
  readonly signal?: Signal | undefined;
  /** 大块内容的引用；登记后由宿主决定何时取回，压缩恢复靠它。 */
  readonly preserve?: ContentRef | undefined;
}

/**
 * Runtime 可调用工具的中性定义。
 * `name` 是模型看到的调用名，必须与 `schema.function.name` 一致——
 * 不一致会让「模型请求的工具」与「分发时查找的工具」指向两个不同的东西。
 */
export interface Tool {
  /** 模型看到的调用名，必须与 `schema.function.name` 一致，否则查找与请求会指向两个工具。 */
  readonly name: string;
  /** 发给模型的工具声明；名字之外还有参数 Schema 与 `interrupting` 提示。 */
  readonly schema: ToolSchema;
  /**
   * 执行工具。
   *
   * 失败语义：返回被拒绝的 Promise 或抛出都表示执行失败，由 Dispatcher 转成工具结果事件；
   * 返回 `ToolResult` 中的 `signal` 才是「要求挂起」的正规通道。
   *
   * @param params - 已解析为 JSON 值的调用参数；是否合 Schema 由工具自行校验。
   * @param context - 调用身份、revision 与并发围栏令牌。
   * @param signal - 取消信号；工具应在长耗时等待点检查它。
   * @returns 工具执行结果，可携带控制信号或内容引用。
   */
  execute(
    params: JsonValue,
    context: ToolCallContext,
    signal: AbortSignal,
  ): Promise<ToolResult>;
}
