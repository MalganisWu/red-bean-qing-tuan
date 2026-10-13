import type { RuntimeResult } from "../../../runtime/run/result/runtime-result.js";
import { cloneCheckpoint } from "../../checkpoint/codec/checkpoint-clone.js";
import {
  cloneRuntimeContentRef,
  cloneRuntimeMessages,
  emptyRuntimeCheckpoint,
  runtimeResultFromCheckpoint,
  runtimeResultFromRecord,
} from "../../../runtime/run/result/runtime-result-mapper.js";
import type { AgentExecution } from "../../../pipeline/execution/port/agent-execution.js";
import { ReactAgentExecutionError } from "../../../pipeline/execution/agent-execution-error.js";
import { RuntimeContext } from "../../../pipeline/context/runtime-context.js";
import type { ReactResult } from "../../../pipeline/react-loop/react-loop.js";
import {
  CONTENT_REFS_METADATA_KEY,
  type ContentRef,
} from "../../../protocol/content-reference.js";
import type { RuntimeEvent } from "../../../protocol/event.js";
import type { RawMessage } from "../../../protocol/message.js";
import {
  type Checkpoint,
  type CheckpointStatus,
} from "../../checkpoint/model/checkpoint.js";
import { CHECKPOINT_STATUSES } from "../../checkpoint/checkpoint-status.js";
import type {
  CheckpointRecord,
  CheckpointStore,
} from "../../checkpoint/store/port/checkpoint-store.js";
import type {
  EventSink,
  EventSinkErrorPolicy,
} from "../model/runtime-run-options.js";
import { EVENT_SINK_ERROR_POLICIES } from "../event-sink-error-policy.js";
import {
  combineRuntimeErrors,
  failRuntimeExecution,
  normalizeRuntimeError,
  runtimeAbortError,
} from "../error/runtime-execution-error.js";

/**
 * 保存 Checkpoint 的超时。保存用独立的超时信号，不受运行取消影响——
 * 一次被取消的运行仍然要把「取消了」这个事实落盘，否则宿主会看到一个悬空的 thread。
 * 但也不能无限等：存不进去就如实报失败，好过整个调用挂死。
 */
const CHECKPOINT_SAVE_TIMEOUT_MS = 5_000;

/** 高层编排整理后的单次执行输入；集合由执行函数复制后再写入状态。 */
export interface RuntimeExecutionInput {
  readonly threadId: string;
  readonly userId: string;
  readonly requestId: string;
  readonly traceId: string;
  readonly history: readonly RawMessage[];
  readonly messages: readonly RawMessage[];
  readonly contentRefs: readonly ContentRef[];
  readonly lastResumeInterrupt: string;
  readonly checkpointRevision: bigint;
  readonly fencingToken: bigint;
  readonly claimRequestId: string;
}

/** 执行、Checkpoint 与事件出口的显式依赖，不持有产品 Repository。 */
export interface RuntimeAgentExecutionDependencies {
  readonly execution: AgentExecution;
  readonly store: CheckpointStore | undefined;
  readonly eventSink: EventSink | undefined;
  readonly eventPolicy: EventSinkErrorPolicy;
}

/**
 * 执行一次已经准备好的 Runtime 上下文，并把终态可靠映射、保存为 Checkpoint。
 * 请求校验、历史装载和 resume claim 不属于此职责。
 * @param dependencies - 显式依赖（执行器、Store、事件出口与策略）；没有 Store 时状态只留在返回的结果里。
 * @param input - 已整理好的单次执行输入；其中的 revision 与 fencing 决定保存时的 CAS 与高水位。
 * @param signal - 本次运行的取消信号；已中止时模型一次都不调用，但仍会尝试写一次 CANCELLED 的 Checkpoint。
 * @returns 保存后的终态结果（携带 Store 的 revision）；保存失败或事件出口出错时抛携带结果的 RuntimeExecutionError。
 */
export async function executeRuntimeAgent(
  dependencies: RuntimeAgentExecutionDependencies,
  input: RuntimeExecutionInput,
  signal: AbortSignal,
): Promise<RuntimeResult> {
  // 进入时已被取消：模型一次都不会调用，但**仍然尝试写一次 Checkpoint**。
  // 不写的话，Store 里这个 thread 就停在挂起态且没有任何「已被取消」的痕迹，
  // 宿主既不知道它结束了，也无法据 revision 安全地重建它。
  if (signal.aborted) {
    const checkpoint = {
      ...emptyRuntimeCheckpoint(
        input.threadId,
        input.userId,
        CHECKPOINT_STATUSES.CANCELLED,
        [...input.history, ...input.messages],
      ),
      contentRefs: input.contentRefs.map(cloneRuntimeContentRef),
      lastResumeInterrupt: input.lastResumeInterrupt,
    };
    let result = runtimeResultFromCheckpoint(checkpoint);
    try {
      result = runtimeResultFromRecord(
        await saveCheckpoint(dependencies.store, checkpoint, input),
      );
    } catch (saveCause: unknown) {
      // 连取消都没记下来：降级为 failed，并把取消与保存失败两个原因都带上。
      result.status = CHECKPOINT_STATUSES.FAILED;
      result.checkpoint.status = CHECKPOINT_STATUSES.FAILED;
      return failRuntimeExecution(
        result,
        `run cancelled before model execution: ${normalizeRuntimeError(saveCause).message}`,
        combineRuntimeErrors([
          runtimeAbortError(signal),
          normalizeRuntimeError(saveCause),
        ]),
      );
    }
    // 取消是「有结果的中止」而非异常，但这里用 failRuntimeExecution 抛出，
    // 以便调用方拿到带 CANCELLED 状态与完整 checkpoint 的 RuntimeExecutionError。
    return failRuntimeExecution(
      result,
      `run cancelled before model execution: ${runtimeAbortError(signal).message}`,
      runtimeAbortError(signal),
    );
  }

  // 运行期的作用域化取消：事件出口出错时需要中止本次运行，但不能去动调用方传进来的 signal
  // ——那是调用方的对象，中止它等于替调用方做了决定。
  const runController = new AbortController();
  const runSignal = AbortSignal.any([signal, runController.signal]);
  let sinkError: Error | undefined;
  const context = new RuntimeContext({
    sessionId: input.threadId,
    checkpointId: input.threadId,
    userId: input.userId,
    requestId: input.requestId,
    traceId: input.traceId,
    checkpointRevision: input.checkpointRevision,
    fencingToken: input.fencingToken,
    messages: input.messages,
    llmContext: input.history,
    metadata:
      input.contentRefs.length > 0
        ? new Map([
            [
              CONTENT_REFS_METADATA_KEY,
              input.contentRefs.map(cloneRuntimeContentRef),
            ],
          ])
        : undefined,
    eventSink: eventPublisher(
      dependencies.eventSink,
      dependencies.eventPolicy,
      runController,
      (): Error | undefined => sinkError,
      (error: Error): void => {
        sinkError ??= error;
      },
    ),
  });

  let react: ReactResult;
  let runError: Error | undefined;
  try {
    react = await dependencies.execution.execute(context, runSignal);
  } catch (value: unknown) {
    // ReactAgentExecutionError 是「执行失败但仍留有部分状态」，比裸错误的可用信息多：
    // 取它的 cause 作为根因，取它的 result 作为已产出的上下文。两者都没有时才退回空结果。
    runError =
      value instanceof ReactAgentExecutionError && value.cause !== undefined
        ? normalizeRuntimeError(value.cause)
        : normalizeRuntimeError(value);
    react =
      value instanceof ReactAgentExecutionError && value.result
        ? value.result
        : {
            llmContext: [...input.history, ...input.messages],
            tokensUsed: 0,
            finishReason: "",
            cancelled: signal.aborted,
            stopReason: "",
          };
  }
  let result = resultFromReact(input, react, runError);
  // 工具在执行期可能往上下文里寄存了新的内容引用（长内容转为引用存储），
  // 这些引用必须随 Checkpoint 一起持久化，否则恢复后引用就丢了。
  const refs = context.metadata.get(CONTENT_REFS_METADATA_KEY);
  if (Array.isArray(refs) && refs.every(isContentRef)) {
    result.checkpoint.contentRefs = refs.map(cloneRuntimeContentRef);
  }
  // 事件出口出错意味着宿主漏掉了一段过程：结果状态要降级，但已产出的内容照常保存。
  if (sinkError) {
    runError = runError
      ? combineRuntimeErrors([runError, sinkError])
      : sinkError;
    result.status = CHECKPOINT_STATUSES.FAILED;
    result.checkpoint.status = CHECKPOINT_STATUSES.FAILED;
  }
  try {
    result = runtimeResultFromRecord(
      await saveCheckpoint(dependencies.store, result.checkpoint, input),
    );
  } catch (value: unknown) {
    const saveError = normalizeRuntimeError(value);
    result.status = CHECKPOINT_STATUSES.FAILED;
    result.checkpoint.status = CHECKPOINT_STATUSES.FAILED;
    // revision 归零：保存失败意味着这个结果并不对应 Store 里的任何版本，
    // 留着一个看似有效的旧 revision 会让调用方以为自己拿到了可 CAS 的句柄。
    result.revision = 0n;
    runError = runError
      ? combineRuntimeErrors([runError, saveError])
      : saveError;
  }
  if (runError) {
    return failRuntimeExecution(
      result,
      `run agent: ${runError.message}`,
      runError,
    );
  }
  return result;
}

/**
 * 包一层事件出口，按策略处理 sink 抛错。三种策略的差别只在抛错之后：
 * - `IGNORE`：吞掉，运行继续。
 * - `FAIL_FAST`：记下第一个错误并中止运行；此后再来的事件直接丢弃（`currentError()` 非空即返回），
 *   因为渠道已经坏了，继续往里投递只会重复失败。
 * - 默认（捕获）：记下错误、中止运行，但**不抛出**——调用点多半在工具或模型流的深处，
 *   在这里抛会把原始的执行路径打断，反而丢掉更有价值的错误。
 *
 * 只保留**第一个**错误（`??=`）：后续的同类失败是同一个根因的重复，覆盖它只会让根因后移。
 */
function eventPublisher(
  sink: EventSink | undefined,
  policy: EventSinkErrorPolicy,
  controller: AbortController,
  currentError: () => Error | undefined,
  captureError: (error: Error) => void,
): ((event: RuntimeEvent) => void) | undefined {
  if (!sink) return undefined;
  /** 事件出口：按 policy 决定事件出口抛错时是吞掉、上报还是直接中止本次运行。 */
  const publishEvent = (event: RuntimeEvent): void => {
    if (currentError() && policy === EVENT_SINK_ERROR_POLICIES.FAIL_FAST) {
      return;
    }
    try {
      sink.publish(event);
    } catch (value: unknown) {
      if (policy === EVENT_SINK_ERROR_POLICIES.IGNORE) return;
      const error = normalizeRuntimeError(value);
      captureError(error);
      controller.abort(error);
    }
  };
  return publishEvent;
}

/**
 * 把 ReAct 的返回翻译成终态。
 *
 * 状态判定的**先后顺序即优先级**，不能重排：取消与失败要压过挂起——
 * 一次既被取消又留下 interrupt 的运行，对宿主而言是「取消了」，不是「等你确认」；
 * 轮次耗尽（`max_iterations`）排在最后，它是唯一一种「跑完了但没跑完」的终态。
 *
 * `version` 固定为 1：这是 Checkpoint 的结构代次，从本轮开始计入持久化版本（0 只用于内存态）。
 */
function resultFromReact(
  input: Pick<
    RuntimeExecutionInput,
    "threadId" | "userId" | "lastResumeInterrupt"
  >,
  react: ReactResult,
  runError: Error | undefined,
): RuntimeResult {
  let status: CheckpointStatus = CHECKPOINT_STATUSES.COMPLETED;
  if (react.cancelled) status = CHECKPOINT_STATUSES.CANCELLED;
  else if (runError) status = CHECKPOINT_STATUSES.FAILED;
  else if (react.interrupt) status = CHECKPOINT_STATUSES.SUSPENDED;
  else if (react.stopReason === "max_iterations") {
    status = CHECKPOINT_STATUSES.EXHAUSTED;
  }
  const checkpoint: Checkpoint = {
    version: 1,
    threadId: input.threadId,
    userId: input.userId,
    status,
    messages: cloneRuntimeMessages(react.llmContext),
    contentRefs: [],
    ...(react.interrupt ? { interrupt: { ...react.interrupt } } : {}),
    lastResumeInterrupt: input.lastResumeInterrupt,
    tokensUsed: react.tokensUsed,
    finishReason: react.finishReason,
  };
  return runtimeResultFromCheckpoint(checkpoint);
}

/**
 * 保存终态；没有 Store 或 threadId 为空时只返回一份本地副本。
 *
 * 后一种情况不是「跳过保存」的权宜之计，而是一种正式模式：无 Store 的 SDK 用法下
 * Runtime 只负责产出结果，状态由调用方自己管理，revision 恒为 0。
 *
 * `claimRequestId` 只在非空时下发——传空串会被 Store 当成「试图越过认领直接写」而拒绝。
 * 保存用独立的超时信号，与本次运行的取消无关（见 CHECKPOINT_SAVE_TIMEOUT_MS 的说明）。
 */
async function saveCheckpoint(
  store: CheckpointStore | undefined,
  checkpoint: Checkpoint,
  input: Pick<
    RuntimeExecutionInput,
    "checkpointRevision" | "fencingToken" | "claimRequestId"
  >,
): Promise<CheckpointRecord> {
  if (!store || checkpoint.threadId === "") {
    return { checkpoint: cloneCheckpoint(checkpoint), revision: 0n };
  }
  return store.save(
    {
      checkpoint,
      expectedRevision: input.checkpointRevision,
      fencingToken: input.fencingToken,
      ...(input.claimRequestId !== ""
        ? { claimRequestId: input.claimRequestId }
        : {}),
    },
    AbortSignal.timeout(CHECKPOINT_SAVE_TIMEOUT_MS),
  );
}

function isContentRef(value: unknown): value is ContentRef {
  return (
    typeof value === "object" &&
    value !== null &&
    "kind" in value &&
    typeof value.kind === "string" &&
    "key" in value &&
    typeof value.key === "string"
  );
}
