import { SIGNAL_KINDS, type Signal } from "../../protocol/interrupt.js";
import { toJsonValue } from "../../protocol/json.js";

/**
 * 仅在校验并复制 JSON 载荷后创建 interrupt signal。
 *
 * `toJsonValue` 这一步不能省：载荷会被写进 checkpoint 并跨进程恢复，
 * 一个含函数、undefined 或循环引用的载荷在这里挡下来，好过在持久化或重放时才发现。
 */
export function createInterruptSignal(payload: unknown): Signal {
  return {
    kind: SIGNAL_KINDS.INTERRUPT,
    payload: toJsonValue(payload),
  };
}
