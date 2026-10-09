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

/** 顺序执行普通节点，并保证 finally 节点在独立清理信号下运行。 */
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

/** 显式收集节点与 Hook 的轻量构建器，不保存全局注册状态。 */
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
