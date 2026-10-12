import type { RuntimeContext } from "../../context/runtime-context.js";
import type { RuntimeNode } from "../../node/port/runtime-node.js";
import type { RuntimePipeline } from "../port/runtime-pipeline.js";
import type { PipelineHook } from "../../hook/port/message-hook.js";

const DEFAULT_FINALLY_TIMEOUT_MS = 30_000;

function normalizeError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

function wrapError(message: string, cause: unknown): Error {
  return new Error(`${message}: ${normalizeError(cause).message}`, {
    cause: normalizeError(cause),
  });
}

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
  readonly #nodes: readonly RuntimeNode[];
  readonly #finalNodes: readonly RuntimeNode[];
  readonly #hooks: readonly PipelineHook[];
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
  readonly #nodes: RuntimeNode[] = [];
  readonly #finalNodes: RuntimeNode[] = [];
  readonly #hooks: PipelineHook[] = [];
  #finallyTimeoutMs = DEFAULT_FINALLY_TIMEOUT_MS;

  public add(node: RuntimeNode): this {
    this.#nodes.push(node);
    return this;
  }

  public addFinally(node: RuntimeNode): this {
    this.#finalNodes.push(node);
    return this;
  }

  public addHook(hook: PipelineHook): this {
    this.#hooks.push(hook);
    return this;
  }

  /** 非正整数一律退回默认值而不是抛错：清理超时配错不该让整条 pipeline 起不来。 */
  public withFinallyTimeout(timeoutMs: number): this {
    this.#finallyTimeoutMs =
      Number.isSafeInteger(timeoutMs) && timeoutMs > 0
        ? timeoutMs
        : DEFAULT_FINALLY_TIMEOUT_MS;
    return this;
  }

  public build(): RuntimePipeline {
    return new SequentialPipeline(
      this.#nodes,
      this.#finalNodes,
      this.#hooks,
      this.#finallyTimeoutMs,
    );
  }
}
