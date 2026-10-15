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
import { abortError, raceAbort } from "../../protocol/abort-signal.js";

/** 流式接收 Tool Call 增量时使用的内部可变组装状态，与公开的 ToolCallEntry 同形但可写。 */
interface MutableToolCallEntry {
  /** 工具调用 ID；通常只在第一片增量里出现，后续分片为空则不覆盖。 */
  id: string;
  /** 工具名的分片；组装时非空即整体替换而非追加，避免名字被重复下发时被拼接。 */
  nameParts: string[];
  /** 参数 JSON 的增量分片；按到达顺序拼接成完整参数。 */
  argumentParts: string[];
}

/** 单个 Tool Call 的隔离执行结果；失败保留 Error 供主循环统一转换。 */
export interface ToolExecution {
  /** 本次调用的原始调用信息。 */
  readonly call: ToolCall;
  /** 工具返回的结果；失败时为空内容占位，错误详情在 `error` 字段。 */
  readonly result: ToolResult;
  /** 工具失败时的错误；成功时为 undefined。 */
  readonly error?: Error | undefined;
}

/**
 * 判断这一批工具调用里是否有中断请求，并把批次收窄到它。
 *
 * ⚠️ **屏障的判据是 `ToolSchema.interrupting` 这个静态声明，运行期返回的
 * `ToolResult.signal` 不参与这里的判定。** 这是一个硬性前提，不是优化：
 * 本函数在 `dispatchToolBatch` **之前**运行，一旦决定这批里有中断就直接返回，
 * 整批（连同其余已声明的调用）都不会被派发。反过来，一个没有声明 `interrupting`
 * 的工具即使在运行期返回了中断信号，也得不到屏障——同批的其他工具已经并发跑完，
 * 信号只能等到 `applyToolExecutionResults` 才被发现，那时已经晚了。
 *
 * 所以：**任何可能要求人工确认的工具，都必须在自己的 ToolSchema 上声明
 * `interrupting: true`**。这是工具作者与 Runtime 之间的契约，漏声明的后果是静默的
 * ——不会报错，只是屏障消失。
 *
 * 一批里出现超过一个声明为中断的调用则直接判错：屏障需要唯一的一个「在等谁确认」。
 *
 * @param tools - 本轮可用工具声明；屏障只认其中的 `interrupting` 静态标记，不看运行期结果。
 * @param calls - 本批待派发的调用；无中断声明时原样返回，不复制。
 * @returns 本批有中断调用时返回仅含该调用的批次，否则原样返回入参批次。
 */
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

/**
 * 往上下文元数据里追加一条内容引用。
 * 元数据是开放字典，可能被宿主写成任意形状；只有整段都是合法引用时才基于它扩展，
 * 否则从空数组重建——宁可丢掉宿主写入的非法内容，也不要把坏数据带进恢复流程。
 *
 * @param context - 运行上下文；引用会写进它的 metadata，覆盖同键的旧值。
 * @param reference - 要登记的单个内容引用，追加到既有列表末尾。
 */
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

/**
 * 参数解析失败就原样返回字符串：中断是要交给宿主展示的，宁可显示原始文本也不要因为解析失败丢掉请求。
 *
 * @param argumentsJson - 中断工具调用携带的原始参数文本，可能不是合法 JSON。
 * @returns 解析成功时为规范化后的 JsonValue，失败时为原样字符串。
 */
export function parseInterruptArguments(argumentsJson: string): JsonValue {
  try {
    const value: unknown = JSON.parse(argumentsJson);
    return toJsonValue(value);
  } catch {
    return argumentsJson;
  }
}

/**
 * 并发派发一批工具调用，返回值**与入参顺序一一对应**。
 *
 * 用共享游标 `nextIndex` 让若干 worker 抢任务，而不是把调用均分给 worker：
 * 均分会让一个慢工具拖住整条队列，抢任务则让快的先补位。
 * 游标无需加锁——读取与自增之间没有 `await`，JS 的单线程执行保证不会有两个 worker
 * 拿到同一个下标。
 *
 * 结果写进预分配的定长数组（按调用下标落位）再过滤空洞，因此并发完成顺序不影响
 * 返回顺序；任何一个 worker 抛出（例如取消）都会让 `Promise.all` 直接拒绝，
 * 整批结果作废。
 *
 * @param calls - 本批要派发的调用；返回值与它一一对应。
 * @param context - 运行上下文，用于发出工具事件等。
 * @param dispatcher - 真正执行工具的分发器。
 * @param tools - 本轮可用工具声明，用于判定哪些调用声明了 interrupting。
 * @param config - 运行配置；`maxConcurrentTools` 决定并发上限，缺省或非法则不限并发。
 * @param signal - 整次运行的取消信号；取消会让整批结果作废并抛出。
 * @returns 与入参顺序一致的执行记录；单个工具失败以带 error 的记录返回而非抛出。
 */
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
  // 取下一个待执行调用的下标；取空即表示这一轮并发已经分完。
  async function worker(): Promise<void> {
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
  }
  await Promise.all(
    Array.from({ length: concurrency }, (): Promise<void> => worker()),
  );
  return results.filter(
    (result): result is ToolExecution => result !== undefined,
  );
}

/**
 * 把一个流式增量并入组装缓冲。
 *
 * 三类字段的合并规则不同，别写成一样的：
 * - `id`：只在非空时覆盖——id 通常只在第一片出现。
 * - `name`：非空时**整体替换**（`= [name]` 而非 push），因为名字可能被重复下发，
 *   追加会得到 `read_fileread_file`。
 * - `arguments`：总是 push，JSON 参数正是按增量分片拼出来的。
 *
 * 缺失 `index` 时按 0 处理：单工具调用的场景下 provider 可能省略该字段。
 *
 * @param buffer - 就地更新的组装缓冲，按 `index` 索引。
 * @param calls - 本次到达的增量分片，按顺序并入缓冲。
 */
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

/**
 * 把可变缓冲暴露为只读视图。这里只是类型层面的收窄（运行时仍是同一个 Map），
 * 目的是让「组装期可变、消费期只读」这条边界在类型上可见——
 * 交给 `assembleToolCalls` 之后就不该再有人往里写。
 *
 * @param buffer - 组装期的可变缓冲；本函数不复制它，只做类型收窄。
 * @returns 同一份 Map 的只读视图，运行时仍是原对象，写入仍会反映到调用方看到的数据上。
 */
export function immutableToolCallBuffer(
  buffer: ReadonlyMap<number, MutableToolCallEntry>,
): ReadonlyMap<number, ToolCallEntry> {
  return buffer;
}

/**
 * 派发单个工具调用，把「取消」「超时」「工具自己报错」三种结局收敛成一条执行记录。
 *
 * 关键区分是 **parentSignal 与 signal**：
 * - `parentSignal` 是整次运行的取消信号；它一旦触发，异常直接向上抛（运行被取消）。
 * - 局部 `signal` 额外叠加了工具超时。超时只中止这一个工具，
 *   `parentSignal` 不受影响，因此走的是「返回一条带 error 的执行记录」而不是取消——
 *   模型会读到超时信息并自行决定重试或换法子。
 *
 * 声明为 interrupting 的工具不发 `TOOL_START`：它这一轮的作用是请求确认而非真的干活，
 * 展示层不该把它显示成一个正在执行、结果待定的工具。
 * 同理，带 `result.signal` 的结果也不发 `TOOL_RESULT`——那里还没有结果可报。
 *
 * @param call - 本次要派发的工具调用。
 * @param context - 运行上下文，用于发出工具事件与构造工具侧窄上下文。
 * @param dispatcher - 真正执行工具的分发器。
 * @param tools - 本轮可用工具声明，用于判定本次调用是否声明为 interrupting。
 * @param config - 运行配置；`toolTimeoutSeconds` 决定本工具的局部超时。
 * @param parentSignal - 整次运行的取消信号；它一旦触发就上抛取消，而非返回错误记录。
 * @returns 本次调用的执行记录；工具自身失败以带 error 的记录返回而非抛出。
 */
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
    // 再套一层 raceAbort：signal 只能「通知」工具，无法强制它停下。
    // 工具若不理会 signal，调用方至少能立刻脱身，而不是被一个卡死的实现拖住。
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
    // 工具失败不是运行失败：把错误包成 JSON 交给模型，让它自己决定怎么办。
    // 这里必须照常发 TOOL_RESULT——展示层需要知道这个工具已经结束（失败也是一种结束），
    // 否则界面上会留下一个永远转圈的工具。
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

/**
 * 内容引用的结构守卫：只认形状完整的对象，坏数据一律判否。
 *
 * @param value - 待校验的候选值，通常来自宿主可写的元数据字典。
 * @returns 该值是否具备 `kind` 与 `key` 两个字段。
 */
function isContentRef(value: unknown): value is ContentRef {
  return (
    typeof value === "object" &&
    value !== null &&
    "kind" in value &&
    "key" in value
  );
}

/**
 * 从运行上下文抽出一个只读的窄上下文交给工具，避免工具拿到整个 RuntimeContext。
 *
 * 事件出口用闭包转发到 `context.emit`，因此工具侧发的仍然是同一条事件通道。
 *
 * @param context - 本次运行上下文，提供身份、checkpoint 修订号与事件出口。
 * @param call - 本次工具调用，其 id 作为窄上下文的 callId。
 * @returns 供工具使用的窄上下文。
 */
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
