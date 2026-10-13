import type { JsonObject, JsonValue } from "./json.js";

/** 工具控制信号的种类。目前只有中断一种；用常量表而非裸字面量，是为了让判别与构造共用同一处定义。 */
export const SIGNAL_KINDS = Object.freeze({
  INTERRUPT: "interrupt",
} as const);

/** 工具控制信号的稳定判别值。 */
export type SignalKind = (typeof SIGNAL_KINDS)[keyof typeof SIGNAL_KINDS];

/** 工具向 Runtime 返回的控制信号；payload 必须属于 JSON 值域。 */
export interface Signal {
  readonly kind: SignalKind;
  readonly payload: JsonValue;
}

/** 可持久化并由宿主恢复的结构化中断，不依赖具体工具名。 */
export interface Interrupt {
  readonly toolCallId: string;
  readonly toolName: string;
  readonly arguments: JsonValue;
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
