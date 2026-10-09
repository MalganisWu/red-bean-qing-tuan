import { SIGNAL_KINDS, type Signal } from "../../protocol/interrupt.js";
import { toJsonValue } from "../../protocol/json.js";

/** 仅在校验并复制 JSON 载荷后创建 interrupt signal。 */
export function createInterruptSignal(payload: unknown): Signal {
  return {
    kind: SIGNAL_KINDS.INTERRUPT,
    payload: toJsonValue(payload),
  };
}
