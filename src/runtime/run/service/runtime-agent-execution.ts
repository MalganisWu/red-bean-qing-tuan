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
 */
export async function executeRuntimeAgent(
  dependencies: RuntimeAgentExecutionDependencies,
  input: RuntimeExecutionInput,
  signal: AbortSignal,
): Promise<RuntimeResult> {
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
    return failRuntimeExecution(
      result,
      `run cancelled before model execution: ${runtimeAbortError(signal).message}`,
      runtimeAbortError(signal),
    );
  }

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
  const refs = context.metadata.get(CONTENT_REFS_METADATA_KEY);
  if (Array.isArray(refs) && refs.every(isContentRef)) {
    result.checkpoint.contentRefs = refs.map(cloneRuntimeContentRef);
  }
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

function eventPublisher(
  sink: EventSink | undefined,
  policy: EventSinkErrorPolicy,
  controller: AbortController,
  currentError: () => Error | undefined,
  captureError: (error: Error) => void,
): ((event: RuntimeEvent) => void) | undefined {
  if (!sink) return undefined;
  return (event: RuntimeEvent): void => {
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
}

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
