import type { LlmAdapter } from "../../llm/adapter/port/llm-adapter.js";
import type { ToolDispatcher } from "../../tool/dispatcher/port/tool-dispatcher.js";
import type { RuntimeResult } from "../run/result/runtime-result.js";
import type { RunIdentity } from "../../protocol/run-identity.js";

export const RUN_KINDS = Object.freeze({
  RUN: "run",
  RESUME: "resume",
} as const);

/** 插件可观察的 Runtime 调用种类。 */
export type RunKind = (typeof RUN_KINDS)[keyof typeof RUN_KINDS];

/** 传给运行中间件的稳定调用身份与调用种类。 */
export interface RunInfo extends RunIdentity {
  readonly kind: RunKind;
}

/** 运行中间件包装的下一跳；调用方拥有 AbortSignal 并负责传播取消。 */
export type RunHandler = (signal: AbortSignal) => Promise<RuntimeResult>;

/** 包裹一次 Runtime 调用的洋葱式中间件。 */
export type RunMiddleware = (
  info: RunInfo,
  next: RunHandler,
  signal: AbortSignal,
) => Promise<RuntimeResult>;

/** 在构造期包装 LlmAdapter 的插件扩展点。 */
export interface LlmMiddleware {
  wrapLlm(next: LlmAdapter): LlmAdapter;
}

/** 在构造期包装 ToolDispatcher 的插件扩展点。 */
export interface ToolMiddleware {
  wrapToolDispatcher(next: ToolDispatcher): ToolDispatcher;
}

/** Runtime 关闭时逆序调用的资源释放回调。 */
export type CloseHandler = (signal: AbortSignal) => Promise<void>;

/** 静态 Runtime 插件契约；register 完成后注册表立即封闭。 */
export interface RuntimePlugin {
  readonly name: string;
  register(registry: PluginRegistry): void;
}

function normalizeError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

export class PluginRegistry {
  readonly #run: RunMiddleware[] = [];
  readonly #llm: LlmMiddleware[] = [];
  readonly #tool: ToolMiddleware[] = [];
  readonly #closers: CloseHandler[] = [];
  #sealed = false;
  #closed = false;

  public useRun(middleware: RunMiddleware): void {
    this.#requireOpen();
    if (typeof middleware !== "function") {
      throw new TypeError("run middleware must be a function");
    }
    this.#run.push(middleware);
  }

  public useLlm(middleware: LlmMiddleware): void {
    this.#requireOpen();
    if (typeof middleware.wrapLlm !== "function") {
      throw new TypeError("LLM middleware must define wrapLlm");
    }
    this.#llm.push(middleware);
  }

  public useTool(middleware: ToolMiddleware): void {
    this.#requireOpen();
    if (typeof middleware.wrapToolDispatcher !== "function") {
      throw new TypeError("tool middleware must define wrapToolDispatcher");
    }
    this.#tool.push(middleware);
  }

  public onClose(handler: CloseHandler): void {
    this.#requireOpen();
    if (typeof handler !== "function") {
      throw new TypeError("plugin close handler must be a function");
    }
    this.#closers.push(handler);
  }

  public seal(): void {
    this.#sealed = true;
  }

  public runMiddleware(): readonly RunMiddleware[] {
    return [...this.#run];
  }

  public wrapLlm(adapter: LlmAdapter): LlmAdapter {
    let wrapped = adapter;
    for (let index = this.#llm.length - 1; index >= 0; index -= 1) {
      const middleware = this.#llm[index];
      if (!middleware) continue;
      wrapped = middleware.wrapLlm(wrapped);
      if (!wrapped) {
        throw new Error(`LLM middleware at index ${index} returned no adapter`);
      }
    }
    return wrapped;
  }

  public wrapToolDispatcher(dispatcher: ToolDispatcher): ToolDispatcher {
    let wrapped = dispatcher;
    for (let index = this.#tool.length - 1; index >= 0; index -= 1) {
      const middleware = this.#tool[index];
      if (!middleware) continue;
      wrapped = middleware.wrapToolDispatcher(wrapped);
      if (!wrapped) {
        throw new Error(
          `tool middleware at index ${index} returned no dispatcher`,
        );
      }
    }
    return wrapped;
  }

  public async close(signal: AbortSignal): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    const errors: Error[] = [];
    for (let index = this.#closers.length - 1; index >= 0; index -= 1) {
      const closer = this.#closers[index];
      if (!closer) continue;
      try {
        await closer(signal);
      } catch (value: unknown) {
        errors.push(normalizeError(value));
      }
    }
    if (errors.length > 0) {
      throw new AggregateError(
        errors,
        `close runtime plugins: ${errors.map((error) => error.message).join("; ")}`,
      );
    }
  }

  #requireOpen(): void {
    if (this.#sealed) throw new Error("runtime plugin registry is sealed");
  }
}

export function installPlugins(
  plugins: readonly RuntimePlugin[],
): PluginRegistry {
  const registry = new PluginRegistry();
  const names = new Set<string>();
  try {
    for (const [index, plugin] of plugins.entries()) {
      if (!plugin || typeof plugin.register !== "function") {
        throw new TypeError(`runtime plugin at index ${index} is invalid`);
      }
      const name = plugin.name.trim();
      if (name === "") {
        throw new Error(
          `runtime plugin at index ${index} name must not be empty`,
        );
      }
      if (names.has(name)) {
        throw new Error(`duplicate plugin ${JSON.stringify(name)}`);
      }
      names.add(name);
      plugin.register(registry);
    }
    return registry;
  } finally {
    registry.seal();
  }
}

export function runWithMiddleware(
  info: RunInfo,
  middleware: readonly RunMiddleware[],
  finalHandler: RunHandler,
  signal: AbortSignal,
): Promise<RuntimeResult> {
  let handler = finalHandler;
  for (let index = middleware.length - 1; index >= 0; index -= 1) {
    const current = middleware[index];
    if (!current) continue;
    const next = handler;
    handler = (nextSignal: AbortSignal): Promise<RuntimeResult> =>
      current(info, next, nextSignal);
  }
  return handler(signal);
}
