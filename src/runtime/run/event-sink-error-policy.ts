import type { EventSinkErrorPolicy } from "./model/runtime-run-options.js";

/** EventSink 失败时 Runtime 可采用的稳定策略。 */
export const EVENT_SINK_ERROR_POLICIES = Object.freeze({
  FAIL_FAST: "fail_fast",
  IGNORE: "ignore",
} satisfies Readonly<Record<string, EventSinkErrorPolicy>>);
