import type { LlmAdapter } from "../../llm/adapter/port/llm-adapter.js";
import type { ToolDispatcher } from "../../tool/dispatcher/port/tool-dispatcher.js";
import type { RuntimeResult } from "../run/result/runtime-result.js";
import type { RunIdentity } from "../../protocol/run-identity.js";

/** Run 中间件可观察到的调用种类；`resume` 与 `run` 在中间件看来是两次不同的调用。 */
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

/**
 * 构造期开放的插件注册表，`seal()` 之后任何登记都会抛错。
 *
 * 「注册后封闭」是这套插件模型的核心约束：能力图在构造期定死，
 * 运行期不会出现新中间件，所以 wrap 的结果可以被安全地缓存与复用，
 * 也不存在「插件在运行中途改变行为」这类难以复现的问题。
 */
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

  /**
   * **逆序**包装，使先注册的中间件位于最外层。
   * 这就是「先注册的 middleware 位于外层」那条契约的实现：注册顺序即嵌套顺序，
   * 因此最外层的插件能看到并改写后续所有插件与模型之间的交互。
   */
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

  /** 与 `wrapLlm` 同规则：逆序包装，先注册者在外层。 */
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

  /**
   * 逆序释放资源（后创建的先释放），并**收集全部失败后一次性抛出**。
   * 逐个抛出会让第一个失败把后面的清理全部跳过；这里保证每个 closer 都有机会执行，
   * 最终用一个 `AggregateError` 汇总。
   * 幂等：重复调用直接返回，避免宿主在多层关闭流程里重复释放同一批资源。
   */
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

/**
 * 校验插件清单并完成注册。
 *
 * `seal()` 放在 `finally` 里是刻意的：**插件注册失败时注册表也必须封闭**。
 * 否则一个中途抛错的安装会留下一个半成品注册表，而它看起来仍然可用——
 * 后续再往里面登记就会得到一张与构造期预期不符的能力图。
 * 名字去重同理：两个同名插件无法在日志与排障中被区分。
 */
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

/**
 * 把中间件叠成洋葱：逆序包裹，使 `middleware[0]` 成为最外层，最先看到调用、最后看到结果。
 *
 * 注意 `nextSignal`：每个中间件收到的是**上游传给它的**信号，而不是最初那个。
 * 中间件因此可以在自己的作用域内收窄或替换取消信号，而不影响外层。
 */
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
