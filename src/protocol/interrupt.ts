import type { JsonObject, JsonValue } from "./json.js";

/** 工具控制信号的种类。目前只有中断一种；用常量表而非裸字面量，是为了让判别与构造共用同一处定义。 */
export const SIGNAL_KINDS = Object.freeze({
  INTERRUPT: "interrupt",
} as const);

/** 工具控制信号的稳定判别值。 */
export type SignalKind = (typeof SIGNAL_KINDS)[keyof typeof SIGNAL_KINDS];

/** 工具向 Runtime 返回的控制信号；payload 必须属于 JSON 值域。 */
export interface Signal {
  /** 信号种类判别值，当前恒为 `interrupt`。 */
  readonly kind: SignalKind;
  /** 工具自定义的信号载荷；必须落在 JSON 值域内以便持久化。 */
  readonly payload: JsonValue;
}

/** 可持久化并由宿主恢复的结构化中断，不依赖具体工具名。 */
export interface Interrupt {
  /** 触发中断的工具调用标识，宿主据此把响应路由回同一次调用。 */
  readonly toolCallId: string;
  /** 触发中断的工具名；恢复时不依赖它，仅用于诊断与展示。 */
  readonly toolName: string;
  /** 中断发生时模型给出的原始参数快照，恢复时据此重放。 */
  readonly arguments: JsonValue;
  /** 工具自定义的中断载荷，语义完全由工具定义。 */
  readonly payload: JsonValue;
}

/**
 * 将中性 Interrupt 转换为稳定 JSON，不引入 Checkpoint 或宿主语义。
 *
 * @param interrupt - 待序列化的中断；其 `arguments` 与 `payload` 必须已在 JSON 值域内。
 * @returns 键序固定为 `tool_call_id`、`tool_name`、`arguments`、`payload` 的 JSON 对象，
 *   四个字段恒被写出，可参与快照比对。
 */
export function serializeInterrupt(interrupt: Interrupt): JsonObject {
  return {
    tool_call_id: interrupt.toolCallId,
    tool_name: interrupt.toolName,
    arguments: interrupt.arguments,
    payload: interrupt.payload,
  };
}
