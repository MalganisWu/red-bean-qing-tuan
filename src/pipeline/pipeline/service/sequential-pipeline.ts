import type { RuntimeContext } from "../../context/runtime-context.js";
import type { RuntimeNode } from "../../node/port/runtime-node.js";
import type { RuntimePipeline } from "../port/runtime-pipeline.js";
import type { PipelineHook } from "../../hook/port/message-hook.js";

/** 清理段与 finally 节点的默认超时毫秒数；有了上限，收尾卡住也不会无限期拖住整次运行。 */
const DEFAULT_FINALLY_TIMEOUT_MS = 30_000;

/**
 * 把任意抛出物统一成 Error；非 Error 只做字符串化，不做结构探测。
 *
 * @param value - 任意抛出物；是 Error 时原样返回，否则被包成消息为 `String(value)` 的新 Error。
 * @returns 一定是 Error 实例。
 */
function normalizeError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

/**
 * 给底层原因补一层可读上下文，同时用 `cause` 保留原始错误链。
 *
 * 保留 cause 是为了让上层能沿链继续判断失败性质（例如 hook 是否 fatal），
 * 而不是只拿到一条被重写的消息文本。
 *
 * @param message - 面向人的上下文说明，会被拼在原始消息之前。
 * @param cause - 底层原因，任意抛出物；统一成 Error 后挂到 cause 上。
 * @returns 一条带上下文说明且保留了 cause 的新 Error。
 */
function wrapError(message: string, cause: unknown): Error {
  return new Error(`${message}：${normalizeError(cause).message}`, {
    cause: normalizeError(cause),
  });
}

/**
 * 把多处失败合并成一个待抛出的错误。
 *
 * 只有一处失败时原样返回，避免无谓地多包一层；多处失败用 AggregateError 聚合，
 * 把每条子错误的消息拼在一起，便于日志一次性看全。
 *
 * @param errors - 待合并的错误列表，可为空。
 * @returns 无错误时返回 undefined；单条时返回该错误本身；多条时返回聚合错误。
 */
function joinErrors(errors: readonly Error[]): Error | undefined {
  if (errors.length === 0) return undefined;
  if (errors.length === 1) return errors[0];
  return new AggregateError(
    errors,
    errors.map((error) => error.message).join("; "),
  );
}

/**
 * 顺序执行普通节点，并保证 finally 节点在独立清理信号下运行。
 *
 * 执行分三段，边界由异常处理划定：
 * 1. **正常段**：`onPipelineStart` → 逐节点（`beforeNode` → execute → `afterNode`）。
 *    节点抛错会中断后续节点，但**不立即上抛**——先记下来，让清理段还能跑。
 * 2. **清理段**：`onPipelineEnd` 与 finally 节点都跑在 `AbortSignal.timeout(finallyTimeoutMs)` 上，
 *    **刻意不复用运行信号**。运行被取消时信号已中止，复用会让清理全部跳过，
 *    而「无论成败都要收尾」正是 finally 节点的意义。
 * 3. **汇总段**：把正常段的错误与清理段的错误合并后抛出；两者都为空才视为成功。
 *
 * `afterNode` 的失败被吞掉（见下方注释），`context.pipelineError` 则**逐步更新**——
 * 让后跑的 finally 节点能看到「目前已知的失败」，而不是等到最后才拿到。
 */
export class SequentialPipeline implements RuntimePipeline {
  /** 按注册顺序执行的主流程节点；构造时已复制数组，之后不再受调用方改动影响。 */
  readonly #nodes: readonly RuntimeNode[];
  /** 主流程结束后执行的 finally 节点；跑在独立清理信号下，无论成败都会执行。 */
  readonly #finalNodes: readonly RuntimeNode[];
  /** pipeline 生命周期 Hook 列表，按注册顺序回调。 */
  readonly #hooks: readonly PipelineHook[];
  /** 清理段与 finally 节点的超时毫秒数，用于构造独立的清理信号。 */
  readonly #finallyTimeoutMs: number;

  public constructor(
    nodes: readonly RuntimeNode[],
    finalNodes: readonly RuntimeNode[],
    hooks: readonly PipelineHook[],
    finallyTimeoutMs: number,
  ) {
    this.#nodes = [...nodes];
    this.#finalNodes = [...finalNodes];
    this.#hooks = [...hooks];
    this.#finallyTimeoutMs = finallyTimeoutMs;
  }

  /**
   * 顺序跑完整条 pipeline：普通节点在运行信号下执行，清理段与 finally 节点改用独立的超时信号。
   * 失败不立即上抛，先完成清理再汇总抛出；只有正常段与清理段都无错才算成功。
   *
   * @param context - 本次运行上下文；pipelineError 会在清理段被逐步更新。
   * @param signal - 运行取消信号；取消会中断正常段，但不影响清理段照常运行。
   */
  public async run(
    context: RuntimeContext,
    signal: AbortSignal,
  ): Promise<void> {
    let runError: Error | undefined;
    try {
      for (const hook of this.#hooks) {
        try {
          await hook.onPipelineStart(context, signal);
        } catch (error: unknown) {
          throw wrapError("pipeline hook onPipelineStart failed", error);
        }
      }

      for (const node of this.#nodes) {
        for (const hook of this.#hooks) {
          try {
            await hook.beforeNode(context, node, signal);
          } catch (error: unknown) {
            throw wrapError("pipeline hook beforeNode failed", error);
          }
        }

        let nodeError: Error | undefined;
        try {
          await node.execute(context, signal);
        } catch (error: unknown) {
          nodeError = normalizeError(error);
        }

        // afterNode 是纯观察点：它拿得到节点错误，但它的失败不改变主结果——
        // 一个诊断 hook 出问题不该把一次成功的运行变成失败。
        for (const hook of this.#hooks) {
          try {
            await hook.afterNode(context, node, nodeError, signal);
          } catch {
            // AfterNode 仅用于诊断，其失败不能改变主运行结果。
          }
        }

        if (nodeError) {
          throw wrapError(`node ${node.name} failed`, nodeError);
        }
      }
    } catch (error: unknown) {
      runError = normalizeError(error);
    }

    const cleanupErrors: Error[] = [];
    const cleanupSignal = AbortSignal.timeout(this.#finallyTimeoutMs);
    for (const hook of this.#hooks) {
      try {
        await hook.onPipelineEnd(context, runError, cleanupSignal);
      } catch (error: unknown) {
        cleanupErrors.push(
          wrapError("pipeline hook onPipelineEnd failed", error),
        );
      }
    }

    context.pipelineError = joinErrors([
      ...(runError ? [runError] : []),
      ...cleanupErrors,
    ]);
    for (const node of this.#finalNodes) {
      try {
        await node.execute(context, cleanupSignal);
      } catch (error: unknown) {
        cleanupErrors.push(
          wrapError(`finally node ${node.name} failed`, error),
        );
        context.pipelineError = joinErrors([
          ...(runError ? [runError] : []),
          ...cleanupErrors,
        ]);
      }
    }

    const finalError = joinErrors([
      ...(runError ? [runError] : []),
      ...cleanupErrors,
    ]);
    if (finalError) throw finalError;
  }
}

/**
 * 显式收集节点与 Hook 的轻量构建器，不保存全局注册状态。
 * 链式方法返回 `this`，`build()` 时把数组复制进 Pipeline——
 * 因此构建完再往 builder 里加东西，不会影响已经建好的那一个。
 */
export class PipelineBuilder {
  /** 构建期间累积的主流程节点，按添加顺序执行。 */
  readonly #nodes: RuntimeNode[] = [];
  /** 构建期间累积的 finally 节点，按添加顺序执行。 */
  readonly #finalNodes: RuntimeNode[] = [];
  /** 构建期间累积的 Pipeline Hook，按添加顺序回调。 */
  readonly #hooks: PipelineHook[] = [];
  /** 清理超时毫秒数，默认值可被 withFinallyTimeout 覆盖；非法值不写入。 */
  #finallyTimeoutMs = DEFAULT_FINALLY_TIMEOUT_MS;

  /**
   * 追加一个按注册顺序执行的主流程节点。
   *
   * @param node - 要追加的节点，按添加顺序执行。
   * @returns 当前 builder，便于链式调用。
   */
  public add(node: RuntimeNode): this {
    this.#nodes.push(node);
    return this;
  }

  /**
   * 追加一个 finally 节点；它在主流程结束后、独立清理信号下运行，无论成败都会执行。
   *
   * @param node - 要追加的清理节点，按添加顺序执行。
   * @returns 当前 builder，便于链式调用。
   */
  public addFinally(node: RuntimeNode): this {
    this.#finalNodes.push(node);
    return this;
  }

  /**
   * 注册一个 Pipeline Hook，用于观察 pipeline 与节点的生命周期。
   *
   * @param hook - 要注册的 Hook，按添加顺序回调。
   * @returns 当前 builder，便于链式调用。
   */
  public addHook(hook: PipelineHook): this {
    this.#hooks.push(hook);
    return this;
  }

  /**
   * 非正整数一律退回默认值而不是抛错：清理超时配错不该让整条 pipeline 起不来。
   *
   * @param timeoutMs - 清理段与 finally 节点的超时毫秒数；非正安全整数会被替换为默认值。
   * @returns 当前 builder，便于链式调用。
   */
  public withFinallyTimeout(timeoutMs: number): this {
    this.#finallyTimeoutMs =
      Number.isSafeInteger(timeoutMs) && timeoutMs > 0
        ? timeoutMs
        : DEFAULT_FINALLY_TIMEOUT_MS;
    return this;
  }

  /**
   * 用当前收集的内容构建 pipeline；会把节点与 Hook 数组复制一份，
   * 因此构建后再往 builder 添加不会影响已建好的实例。
   *
   * @returns 一个新的 SequentialPipeline 实例。
   */
  public build(): RuntimePipeline {
    return new SequentialPipeline(
      this.#nodes,
      this.#finalNodes,
      this.#hooks,
      this.#finallyTimeoutMs,
    );
  }
}
