import type { RuntimeConfig } from "../config/runtime-config.js";
import type { ContentRef } from "../../protocol/content-reference.js";
import { CONTENT_REFS_METADATA_KEY } from "../../protocol/content-reference.js";
import { toJsonValue, type JsonValue } from "../../protocol/json.js";
import type { RuntimeContext } from "../context/runtime-context.js";
import type { ToolCallContext } from "../../protocol/run-identity.js";
import { EVENT_TYPES } from "../../protocol/event.js";
import type {
  ToolCall,
  ToolResult,
  ToolSchema,
} from "../../tool/definition/tool.js";
import type { ToolDispatcher } from "../../tool/dispatcher/port/tool-dispatcher.js";
import type { ToolCallEntry } from "./tool-call-buffer.js";

interface MutableToolCallEntry {
  id: string;
  nameParts: string[];
  argumentParts: string[];
}

/** 单个 Tool Call 的隔离执行结果；失败保留 Error 供主循环统一转换。 */
export interface ToolExecution {
  readonly call: ToolCall;
  readonly result: ToolResult;
  readonly error?: Error | undefined;
}

export function isolateInterruptingToolCall(
  tools: readonly ToolSchema[],
  calls: readonly ToolCall[],
): readonly ToolCall[] {
  const interrupting = calls.filter((call): boolean =>
    tools.some(
      (tool): boolean =>
        tool.function.name === call.function.name && tool.interrupting === true,
    ),
  );
  if (interrupting.length === 0) return calls;
  if (interrupting.length > 1)
    throw new Error(
      "multiple interrupting tool calls in one batch are not supported",
    );
  return interrupting;
}

export function appendContentRef(
  context: RuntimeContext,
  reference: ContentRef,
): void {
  const existing = context.metadata.get(CONTENT_REFS_METADATA_KEY);
  const references =
    Array.isArray(existing) && existing.every(isContentRef)
      ? [...existing]
      : [];
  references.push(reference);
  context.metadata.set(CONTENT_REFS_METADATA_KEY, references);
}

export function parseInterruptArguments(argumentsJson: string): JsonValue {
  try {
    const value: unknown = JSON.parse(argumentsJson);
    return toJsonValue(value);
  } catch {
    return argumentsJson;
  }
}

export async function dispatchToolBatch(
  calls: readonly ToolCall[],
  context: RuntimeContext,
  dispatcher: ToolDispatcher,
  tools: readonly ToolSchema[],
  config: RuntimeConfig,
  signal: AbortSignal,
): Promise<readonly ToolExecution[]> {
  const configured = config.maxConcurrentTools;
  const concurrency =
    configured !== undefined &&
    Number.isSafeInteger(configured) &&
    configured > 0
      ? Math.min(configured, calls.length)
      : calls.length;
  const results: Array<ToolExecution | undefined> = Array.from(
    { length: calls.length },
    () => undefined,
  );
  let nextIndex = 0;
  const worker = async (): Promise<void> => {
    while (nextIndex < calls.length) {
      if (signal.aborted) throw abortError(signal);
      const index = nextIndex;
      nextIndex += 1;
      const call = calls[index];
      if (!call) continue;
      results[index] = await dispatchOne(
        call,
        context,
        dispatcher,
        tools,
        config,
        signal,
      );
    }
  };
  await Promise.all(
    Array.from({ length: concurrency }, (): Promise<void> => worker()),
  );
  return results.filter(
    (result): result is ToolExecution => result !== undefined,
  );
}

export function updateToolCallBuffer(
  buffer: Map<number, MutableToolCallEntry>,
  calls: readonly ToolCall[],
): void {
  for (const call of calls) {
    const index = call.index ?? 0;
    const entry = buffer.get(index) ?? {
      id: "",
      nameParts: [],
      argumentParts: [],
    };
    if (call.id !== "") entry.id = call.id;
    if (call.function.name !== "") entry.nameParts = [call.function.name];
    entry.argumentParts.push(call.function.arguments);
    buffer.set(index, entry);
  }
}

export function immutableToolCallBuffer(
  buffer: ReadonlyMap<number, MutableToolCallEntry>,
): ReadonlyMap<number, ToolCallEntry> {
  return buffer;
}

async function dispatchOne(
  call: ToolCall,
  context: RuntimeContext,
  dispatcher: ToolDispatcher,
  tools: readonly ToolSchema[],
  config: RuntimeConfig,
  parentSignal: AbortSignal,
): Promise<ToolExecution> {
  const interrupting = tools.some(
    (tool): boolean =>
      tool.function.name === call.function.name && tool.interrupting === true,
  );
  if (!interrupting)
    context.emit({
      type: EVENT_TYPES.TOOL_START,
      toolName: call.function.name,
      callId: call.id,
      params: null,
    });
  const signal =
    config.toolTimeoutSeconds !== undefined && config.toolTimeoutSeconds > 0
      ? AbortSignal.any([
          parentSignal,
          AbortSignal.timeout(config.toolTimeoutSeconds * 1_000),
        ])
      : parentSignal;
  try {
    const result = await raceAbort(
      Promise.resolve().then((): Promise<ToolResult> =>
        dispatcher.dispatch(call, toolCallContext(context, call), signal),
      ),
      signal,
    );
    if (!result.signal && !parentSignal.aborted) {
      context.emit({
        type: EVENT_TYPES.TOOL_RESULT,
        toolName: call.function.name,
        callId: call.id,
        content: result.content,
      });
    }
    return { call, result };
  } catch (value: unknown) {
    if (parentSignal.aborted) throw abortError(parentSignal);
    const error = value instanceof Error ? value : new Error(String(value));
    if (!parentSignal.aborted) {
      context.emit({
        type: EVENT_TYPES.TOOL_RESULT,
        toolName: call.function.name,
        callId: call.id,
        content: JSON.stringify({ error: error.message }),
        error: error.message,
      });
    }
    return { call, result: { content: "" }, error };
  }
}

function isContentRef(value: unknown): value is ContentRef {
  return (
    typeof value === "object" &&
    value !== null &&
    "kind" in value &&
    "key" in value
  );
}

function toolCallContext(
  context: RuntimeContext,
  call: ToolCall,
): ToolCallContext {
  return {
    threadId: context.sessionId,
    userId: context.userId,
    requestId: context.requestId,
    traceId: context.traceId,
    callId: call.id,
    checkpointRevision: context.checkpointRevision,
    fencingToken: context.fencingToken,
    eventSink: (event): void => context.emit(event),
  };
}

async function raceAbort<TOutput>(
  operation: Promise<TOutput>,
  signal: AbortSignal,
): Promise<TOutput> {
  if (signal.aborted) throw abortError(signal);
  let onAbort: (() => void) | undefined;
  const cancelled = new Promise<never>((_resolve, reject): void => {
    onAbort = (): void => reject(abortError(signal));
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([operation, cancelled]);
  } finally {
    if (onAbort) signal.removeEventListener("abort", onAbort);
  }
}

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new DOMException("operation aborted", "AbortError");
}
