import type { AgentExecution } from "../../../pipeline/execution/port/agent-execution.js";
import { CHECKPOINT_STATUSES } from "../../checkpoint/checkpoint-status.js";
import { CheckpointStoreError } from "../../checkpoint/store/checkpoint-store-error.js";
import { type ConsumeInterruptResult } from "../../checkpoint/store/port/checkpoint-store.js";
import type {
  AgentRequest,
  ResumeRequest,
} from "../../../runtime/run/model/runtime-request.js";
import type { RuntimeResult } from "../../../runtime/run/result/runtime-result.js";
import {
  emptyRuntimeCheckpoint as emptyCheckpoint,
  runtimeResultFromCheckpoint as resultFromCheckpoint,
  runtimeResultFromRecord as resultFromRecord,
} from "../../../runtime/run/result/runtime-result-mapper.js";
import {
  RUN_KINDS,
  runWithMiddleware,
  type PluginRegistry,
  type RunInfo,
  type RunMiddleware,
} from "../../../runtime/plugin/runtime-plugin.js";
import type { RuntimeLifecycle } from "../../lifecycle/port/runtime-lifecycle.js";
import type { ResumeReceiptStore } from "../../resume-receipt/port/resume-receipt-store.js";
import type { ThreadExecutionCoordinator } from "../../thread-execution/port/thread-execution-coordinator.js";
import type { RuntimeRunService } from "../port/runtime-run-service.js";
import type { RuntimeConfiguration } from "../model/runtime-configuration.js";
import type { RuntimeRunDependencies } from "./runtime-run-dependencies.js";
import {
  validateResumeRequest,
  validateRunRequest,
} from "../request/runtime-request-validator.js";
import { executeRuntimeAgent } from "./runtime-agent-execution.js";
import {
  consumeResumeCheckpoint,
  loadRunCheckpoint,
} from "./runtime-checkpoint-session.js";
import {
  replayStatelessResume,
  resultForConsumedResume,
} from "./runtime-resume-replay.js";
import {
  RuntimeExecutionError,
  failRuntimeExecution as executionFailure,
  failedRuntimeResult,
  normalizeRuntimeError as normalizeError,
} from "../error/runtime-execution-error.js";

/**
 * 面向 SDK 消费方的高层门面，负责组装并执行一次完整 model-tool 循环。
 *
 * `run` 与 `resume` 的骨架相同——生命周期记账 → 逐 thread 串行 → 建立起点 → 交给
 * `executeRuntimeAgent` 执行并保存——差别只在于**起点怎么来**：
 * run 从 `state` 或 Store 读，resume 还要先原子领取 interrupt、把应答合成一条 tool 消息补进历史。
 * 领到之后两者走的是同一段代码，这是刻意的：恢复路径若单独实现一套，两边的保存与中断语义迟早会分叉。
 *
 * **失败以结果形式返回，不以异常抛出。** 只有 `RuntimeExecutionError` 会被调用方看到
 * （它带着可诊断的部分结果），其余情况一律返回 status 为 failed/cancelled 的 `RuntimeResult`。
 */
export class DefaultRuntimeRunService implements RuntimeRunService {
  /** 不可变能力图（模型、分发器、Store、事件出口等），构造期一次固定。 */
  readonly #config: RuntimeConfiguration;
  /** 静态插件注册表；构造期已封闭，运行期只用来在 close 时释放资源。 */
  readonly #plugins: PluginRegistry;
  /** 已封闭的 run 中间件快照；run 与 resume 共用同一份，运行期不再变化。 */
  readonly #runMiddleware: readonly RunMiddleware[];
  /** 运行记账与关闭时序的所有者；每次 run/resume 进出一对 beginRun/释放。 */
  readonly #lifecycle: RuntimeLifecycle;
  /** 逐 thread 串行化协调器；保证同 thread 的并发调用排队而非各自跑完再靠 CAS 互相覆盖。 */
  readonly #threadExecution: ThreadExecutionCoordinator;
  /** 无 Store 模式的幂等收据存储；保证同一恢复请求回放而不重复执行工具。 */
  readonly #resumeReceipts: ResumeReceiptStore;
  /** 底层执行器，真正跑 ReAct 循环并生成、保存最终 Checkpoint。 */
  readonly #execution: AgentExecution;

  public constructor(dependencies: RuntimeRunDependencies) {
    this.#lifecycle = dependencies.lifecycle;
    this.#threadExecution = dependencies.threadExecution;
    this.#resumeReceipts = dependencies.resumeReceipts;
    this.#config = dependencies.configuration;
    this.#plugins = dependencies.plugins;
    this.#runMiddleware = dependencies.runMiddleware;
    this.#execution = dependencies.execution;
  }

  /**
   * 执行一次新的 Agent 运行（run 路径），返回终态 RuntimeResult。
   * 失败语义：生命周期拒绝启动（如运行并发预算耗尽）时返回携带错误信息的失败结果，
   * 不向上抛异常；所有路径（含取消/异常）都在 finally 结束本次运行记账。
   * @param request - 本次运行的输入；state/history 与 Store 模式的互斥由请求校验器判定。
   * @param signal - 调用方的取消信号；Runtime 只消费不拥有它，取消会收敛为 cancelled 结果或携带部分结果的异常。
   * @returns 终态 RuntimeResult；除 RuntimeExecutionError 外一律以结果形式返回失败。
   */
  public async run(
    request: AgentRequest,
    signal: AbortSignal,
  ): Promise<RuntimeResult> {
    let endRun: () => void;
    try {
      endRun = this.#lifecycle.beginRun();
    } catch (cause: unknown) {
      const result = this.#failedResult(
        request.threadId ?? "",
        request.userId ?? "",
      );
      return executionFailure(result, normalizeError(cause).message, cause);
    }
    const info: RunInfo = {
      kind: RUN_KINDS.RUN,
      threadId: request.threadId ?? "",
      userId: request.userId ?? "",
      requestId: request.requestId ?? "",
      traceId: request.traceId ?? "",
    };
    // 最后一跳先放进具名变量再传：箭头函数要保留 `this`，命名后调用点只剩「先包好，再执行」。
    const runRequest = (nextSignal: AbortSignal): Promise<RuntimeResult> =>
      this.#runRequest(request, nextSignal);

    try {
      return await runWithMiddleware(
        info,
        this.#runMiddleware,
        runRequest,
        signal,
      );
    } finally {
      endRun();
    }
  }

  /**
   * 恢复一次中断的 Agent 运行（resume 路径）：回答 interrupt 并继续执行。
   * 失败语义同 run；无 Store 模式由进程内 receipt 保证同一恢复请求幂等回放。
   * @param request - 恢复输入；interruptId 必填，无 Store 模式还需 requestId 作幂等键。
   * @param signal - 调用方的取消信号；取消同样收敛为结果或异常，不向外传播原始抛出物。
   * @returns 恢复后的终态 RuntimeResult；命中回执时直接回放，不会二次执行工具。
   */
  public async resume(
    request: ResumeRequest,
    signal: AbortSignal,
  ): Promise<RuntimeResult> {
    let endRun: () => void;
    try {
      endRun = this.#lifecycle.beginRun();
    } catch (cause: unknown) {
      const result = this.#failedResult(
        request.threadId ?? request.state?.threadId ?? "",
        request.userId ?? request.state?.userId ?? "",
      );
      return executionFailure(result, normalizeError(cause).message, cause);
    }
    const info: RunInfo = {
      kind: RUN_KINDS.RESUME,
      threadId: request.threadId ?? request.state?.threadId ?? "",
      userId: request.userId ?? "",
      requestId: request.requestId ?? "",
      traceId: request.traceId ?? "",
    };
    const resumeRequest = (nextSignal: AbortSignal): Promise<RuntimeResult> =>
      this.#resumeRequest(request, nextSignal);

    try {
      return await runWithMiddleware(
        info,
        this.#runMiddleware,
        resumeRequest,
        signal,
      );
    } finally {
      endRun();
    }
  }

  /**
   * 关闭顺序交给 lifecycle 决定：插件必须在其他资源之前反序清理，这里只是把插件关闭登记进去。
   * @param signal - 关闭的取消信号；原样转交插件注册表，只约束等待不取消清理。
   */
  public async close(signal: AbortSignal): Promise<void> {
    await this.#lifecycle.close(() => this.#plugins.close(signal), signal);
  }

  /**
   * run 路径的实际骨架：校验输入、取得 thread 锁、建立执行起点，再交给执行器跑完。
   *
   * 分三个阶段，顺序不可颠倒：先在持有锁之前拒绝互斥输入，再逐 thread 串行，
   * 最后才从 state 或 Store 建立唯一执行起点。线程锁在 finally 中释放。
   *
   * @param request - 已通过门面转交的 run 输入；互斥约束由请求校验器判定
   * @param signal - 调用方取消信号；传播到取锁、读 Store 与执行器
   * @returns 终态结果；失败以结果形式返回，或抛携带部分结果的 RuntimeExecutionError
   */
  async #runRequest(
    request: AgentRequest,
    signal: AbortSignal,
  ): Promise<RuntimeResult> {
    // 阶段一：在获取 thread 锁前拒绝互斥输入，避免无效请求进入状态机。
    const store = this.#config.store;
    const validated = validateRunRequest(request, store !== undefined);
    const { threadId, userId, fencingToken, messages } = validated;

    // 逐 thread 串行：同一个 thread 的并发 run 会在这里排队，而不是各自跑完再靠 CAS 互相覆盖。
    // 拿不到锁（队列满、被取消）时按「这次运行还没开始」构造结果，因此没有 history 可带。
    let release: () => void;
    try {
      release = await this.#threadExecution.acquire(threadId, signal);
    } catch (value: unknown) {
      const error = normalizeError(value);
      // 取消与失败要分开：宿主的重试与告警策略对这两者完全不同。
      const result = resultFromCheckpoint(
        emptyCheckpoint(
          threadId,
          userId,
          signal.aborted
            ? CHECKPOINT_STATUSES.CANCELLED
            : CHECKPOINT_STATUSES.FAILED,
          messages,
        ),
      );
      return executionFailure(result, error.message, value);
    }
    try {
      // 阶段二：从调用方 state 或 Store 建立唯一执行起点。
      const loaded = await loadRunCheckpoint(store, request, signal);
      if (loaded.terminalResult) return loaded.terminalResult;

      // 阶段三：执行 ReAct，并由执行协调器统一生成、保存最终 Checkpoint。
      return await executeRuntimeAgent(
        {
          execution: this.#execution,
          store: this.#config.store,
          eventSink: this.#config.eventSink,
          eventPolicy: this.#config.eventPolicy,
        },
        {
          threadId,
          userId: loaded.userId,
          requestId: request.requestId ?? "",
          traceId: request.traceId ?? "",
          history: loaded.history,
          messages,
          contentRefs: loaded.contentRefs,
          lastResumeInterrupt: loaded.lastResumeInterrupt,
          checkpointRevision: loaded.revision,
          fencingToken,
          claimRequestId: "",
        },
        signal,
      );
    } finally {
      release();
    }
  }

  /**
   * resume 路径的实际骨架：校验身份与 Store 约束、取 thread 锁、原子领取 interrupt，
   * 补入 tool 响应后走与 run 完全相同的执行与保存路径。
   *
   * 与 run 的差别只在「起点怎么来」；领取后复用同一段执行代码，避免恢复路径的保存
   * 与中断语义与 run 分叉。无 Store 模式在领取前先查 receipt 以幂等回放。
   *
   * @param request - 恢复输入；interruptId 必填，无 Store 模式还需 requestId 作幂等键
   * @param signal - 调用方取消信号；传播到取锁、领取与执行器
   * @returns 终态结果；命中回执时直接回放，不会二次执行工具
   */
  async #resumeRequest(
    request: ResumeRequest,
    signal: AbortSignal,
  ): Promise<RuntimeResult> {
    // 阶段一：先确定恢复身份和 Store 约束，再进入同 thread 串行区。
    const store = this.#config.store;
    const validated = validateResumeRequest(request, store !== undefined);
    const { threadId, fencingToken } = validated;

    let release: () => void;
    try {
      release = await this.#threadExecution.acquire(threadId, signal);
    } catch (value: unknown) {
      const error = normalizeError(value);
      const messages = request.state?.messages ?? [];
      const result = resultFromCheckpoint(
        emptyCheckpoint(
          threadId,
          request.userId ?? request.state?.userId ?? "",
          signal.aborted
            ? CHECKPOINT_STATUSES.CANCELLED
            : CHECKPOINT_STATUSES.FAILED,
          messages,
        ),
      );
      return executionFailure(result, error.message, value);
    }
    try {
      // 无 Store 模式由进程内 receipt 保证同一恢复请求幂等回放。
      if (!store) {
        const replay = replayStatelessResume(
          this.#resumeReceipts,
          threadId,
          request,
        );
        if (replay) return replay;
      }

      let consumed: ConsumeInterruptResult;
      try {
        // Store 模式在模型执行前原子领取 interrupt；失败不会产生第二次模型调用。
        consumed = await consumeResumeCheckpoint(
          store,
          threadId,
          request,
          signal,
        );
      } catch (value: unknown) {
        const error = normalizeError(value);
        const result =
          value instanceof CheckpointStoreError && value.record
            ? resultFromRecord(value.record)
            : this.#failedResult(threadId, request.userId ?? "");
        return executionFailure(result, error.message, value);
      }
      const consumedResult = resultForConsumedResume(consumed);
      if (consumedResult) return consumedResult;
      const checkpoint = consumed.record.checkpoint;
      // 原子领取返回的 claim 必须与本次请求完全匹配（requestId + interruptId）：
      // Store 实现若返回陈旧/错配的领取，宁可失败也不消费，避免答非所问。
      if (
        !checkpoint.resumeClaim ||
        checkpoint.resumeClaim.requestId !== (request.requestId ?? "") ||
        checkpoint.resumeClaim.interruptId !== request.interruptId
      ) {
        return executionFailure(
          this.#failedResult(threadId, request.userId ?? ""),
          "checkpoint store returned an invalid resume claim",
          new Error("invalid checkpoint store response"),
        );
      }

      // claim 成功后补入 tool 响应，再复用与 run 完全相同的执行与保存路径。
      // 合成的这条 tool 消息就是模型眼里「那个工具终于返回了」——历史因此与从未中断过一样。
      // `lastResumeInterrupt` 置为本次 interruptId，供后续重放判定「这个中断已处理过」。
      const resultPromise = executeRuntimeAgent(
        {
          execution: this.#execution,
          store: this.#config.store,
          eventSink: this.#config.eventSink,
          eventPolicy: this.#config.eventPolicy,
        },
        {
          threadId: checkpoint.threadId,
          userId: request.userId ?? checkpoint.userId,
          requestId: request.requestId ?? "",
          traceId: request.traceId ?? "",
          history: checkpoint.messages,
          messages: [
            {
              role: "tool",
              content: checkpoint.resumeClaim.response,
              toolCallId: request.interruptId,
            },
          ],
          contentRefs: checkpoint.contentRefs,
          lastResumeInterrupt: request.interruptId,
          checkpointRevision: consumed.record.revision,
          fencingToken,
          claimRequestId: request.requestId ?? "",
        },
        signal,
      );
      try {
        const result = await resultPromise;
        // 无 Store 模式：无论结果还是失败都落 receipt——重试同一恢复请求直接回放，
        // 避免工具重复执行。
        if (!store)
          this.#resumeReceipts.save(threadId, request, result, undefined);
        return result;
      } catch (value: unknown) {
        // 失败同样要留痕。否则一个「执行到一半就炸」的恢复请求被重试时，
        // 会被当成全新请求再跑一遍，工具就被执行了两次。
        if (!store && value instanceof RuntimeExecutionError) {
          this.#resumeReceipts.save(threadId, request, value.result, value);
        }
        throw value;
      }
    } finally {
      release();
    }
  }

  /**
   * 造一个 failed 状态的空结果；集中此处以便失败路径只表达一次意图。
   *
   * @param threadId - 失败结果的归属线程
   * @param userId - 失败结果对应的所有权标识；空串表示无主
   * @returns status 为 failed、不含任何消息与 checkpoint 内容的结果
   */
  #failedResult(threadId: string, userId: string): RuntimeResult {
    return failedRuntimeResult(threadId, userId);
  }
}
