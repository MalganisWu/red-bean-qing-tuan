import type { EventSinkErrorPolicy } from "./model/runtime-run-options.js";

/**
 * EventSink 失败时 Runtime 可采用的稳定策略。
 * 与 `EventSinkErrorPolicy` 类型一一对应；导出运行时常量是为了让宿主能对着字符串做校验，
 * 而不必依赖 TypeScript 的运行时枚举产物。
 */
export const EVENT_SINK_ERROR_POLICIES = Object.freeze({
  FAIL_FAST: "fail_fast",
  IGNORE: "ignore",
} satisfies Readonly<Record<string, EventSinkErrorPolicy>>);
