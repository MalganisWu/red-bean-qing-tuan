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
  /** 本次调用的种类是 run 还是 resume；中间件据此区分两类调用，身份字段由 `RunIdentity` 提供。 */
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
  /**
   * 在构造期把模型适配器包一层；包好的适配器在运行期被复用，不再变化。
   *
   * @param next - 内层的真实适配器，或已被更内层中间件包过的适配器
   * @returns 包装后的适配器；返回空值会被注册表判为错误
   */
  wrapLlm(next: LlmAdapter): LlmAdapter;
}

/** 在构造期包装 ToolDispatcher 的插件扩展点。 */
export interface ToolMiddleware {
  /**
   * 在构造期把工具分发器包一层；包好的分发器在运行期被复用，不再变化。
   *
   * @param next - 内层的真实分发器，或已被更内层中间件包过的分发器
   * @returns 包装后的分发器；返回空值会被注册表判为错误
   */
  wrapToolDispatcher(next: ToolDispatcher): ToolDispatcher;
}

/** Runtime 关闭时逆序调用的资源释放回调。 */
export type CloseHandler = (signal: AbortSignal) => Promise<void>;

/** 静态 Runtime 插件契约；register 完成后注册表立即封闭。 */
export interface RuntimePlugin {
  /** 插件名，用于注册期的去重与排障时的来源识别；不得为空串。 */
  readonly name: string;
  /**
   * 构造期一次性登记该插件的能力；`register` 返回后注册表立即封闭。
   *
   * @param registry - 构造期开放的注册表；实现只能在此登记能力，不得留存它用于运行期
   */
  register(registry: PluginRegistry): void;
}

/**
 * 把任意抛出物归一为 Error，供 close 阶段收集与汇总。
 *
 * 非 Error 的抛出没有 message 可供拼接，包一层才能进 `AggregateError`；已是 Error 的原样返回。
 *
 * @param value - catch 到的任意抛出物
 * @returns 原 Error，或包装后的新 Error
 */
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
  /** run 中间件登记列表；登记顺序即洋葱嵌套顺序，先登记者位于外层。 */
  readonly #run: RunMiddleware[] = [];
  /** LLM 中间件登记列表；在构造期包装适配器后即固定，运行期不再变化。 */
  readonly #llm: LlmMiddleware[] = [];
  /** Tool 中间件登记列表；在构造期包装分发器后即固定，运行期不再变化。 */
  readonly #tool: ToolMiddleware[] = [];
  /** 关闭回调登记列表；close 时按登记的逆序调用。 */
  readonly #closers: CloseHandler[] = [];
  /** 注册表是否已封闭；封闭后任何登记都抛错，该状态不可逆。 */
  #sealed = false;
  /** 是否已执行过 close；保证关闭回调只被释放一次，重复调用直接返回。 */
  #closed = false;

  /**
   * 登记一条 run 中间件；登记顺序即洋葱嵌套顺序，先登记者位于外层。
   * @param middleware - 包裹一次 run/resume 调用的中间件；非函数或注册表已封闭时抛错。
   */
  public useRun(middleware: RunMiddleware): void {
    this.#requireOpen();
    if (typeof middleware !== "function") {
      throw new TypeError("run middleware must be a function");
    }
    this.#run.push(middleware);
  }

  /**
   * 登记一条 LLM 中间件；它在构造期包装模型适配器，运行期不再变化。
   * @param middleware - 必须定义 `wrapLlm` 的对象；缺失该方法或注册表已封闭时抛错。
   */
  public useLlm(middleware: LlmMiddleware): void {
    this.#requireOpen();
    if (typeof middleware.wrapLlm !== "function") {
      throw new TypeError("LLM middleware must define wrapLlm");
    }
    this.#llm.push(middleware);
  }

  /**
   * 登记一条 Tool 中间件；它在构造期包装工具分发器，运行期不再变化。
   * @param middleware - 必须定义 `wrapToolDispatcher` 的对象；缺失该方法或注册表已封闭时抛错。
   */
  public useTool(middleware: ToolMiddleware): void {
    this.#requireOpen();
    if (typeof middleware.wrapToolDispatcher !== "function") {
      throw new TypeError("tool middleware must define wrapToolDispatcher");
    }
    this.#tool.push(middleware);
  }

  /**
   * 登记一个关闭回调；`close` 时按登记的**逆序**调用，后登记者先释放。
   * @param handler - 接收关闭信号的释放回调；每个回调都会被调用，单个失败不会阻断其余清理。
   */
  public onClose(handler: CloseHandler): void {
    this.#requireOpen();
    if (typeof handler !== "function") {
      throw new TypeError("plugin close handler must be a function");
    }
    this.#closers.push(handler);
  }

  /**
   * 封闭注册表：此后任何登记都会抛错。
   *
   * 封闭把能力图钉死在构造期，因此 wrap 的结果可以被安全缓存与复用，
   * 也不存在「插件在运行中途改变行为」这类难以复现的问题。幂等且不可逆。
   */
  public seal(): void {
    this.#sealed = true;
  }

  /**
   * 取当前登记的 run 中间件快照。
   * @returns 按登记顺序排列的只读数组；它是新数组，之后的登记不会影响调用方已拿到的这份。
   */
  public runMiddleware(): readonly RunMiddleware[] {
    return [...this.#run];
  }

  /**
   * **逆序**包装，使先注册的中间件位于最外层。
   * 这就是「先注册的 middleware 位于外层」那条契约的实现：注册顺序即嵌套顺序，
   * 因此最外层的插件能看到并改写后续所有插件与模型之间的交互。
   * @param adapter - 最内层的真实适配器；中间件不得返回空值，否则抛错。
   * @returns 逐层包好的适配器；无中间件时原样返回传入的那个。
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

  /**
   * 与 `wrapLlm` 同规则：逆序包装，先注册者在外层。
   * @param dispatcher - 最内层的真实分发器；中间件不得返回空值，否则抛错。
   * @returns 逐层包好的分发器；无中间件时原样返回传入的那个。
   */
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
   * @param signal - 关闭的取消信号；原样传给每个 closer，由它们自行决定如何配合取消。
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

  /**
   * 校验注册表尚未封闭；封闭后继续登记属于调用方的用法错误。
   *
   * 所有 use* 入口在真正写入前都先过这一关，把「封闭」这条约束集中在一处，
   * 避免某个入口漏判导致运行期还能改写能力图。
   */
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
 * @param plugins - 待安装的插件清单；逐个校验名称非空并去重后按序注册。
 * @returns 已 `seal()` 的注册表；无论注册成功还是中途失败，它都处于封闭态。
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
 * 把中间件叠成洋葱：`dispatch(0)` 进入最外层，`middleware[0]` 最先看到调用、最后看到结果。
 *
 * 「包一层」这个动作在这里**有名字**：哪一行进入下一层
 * （`runNext` → `dispatch(index + 1)`）、哪一行开始执行
 * （`current(info, runNext, nextSignal)`）都能顺着读出来。
 * 反过来，在循环里把 handler 变量反复赋值为匿名闭包，会让洋葱结构藏在赋值里，读代码时看不出
 * 层与层的关系（规则见 `docs/standards/typescript-common-conventions.md`「函数与流程可读性」）。
 *
 * 注意 `nextSignal`：每个中间件收到的是**上游传给它的**信号，而不是最初那个。
 * 中间件因此可以在自己的作用域内收窄或替换取消信号，而不影响外层。
 *
 * `middleware` 视为稠密数组（`registry.runMiddleware()` 由 `push` 构造），
 * 因此遇到 `undefined` 即视为已越过最后一层，交给 `finalHandler`。
 * @param info - 本次调用的身份与种类；原样透传给每个中间件，本函数不读取或改写它。
 * @param middleware - 已封闭的 run 中间件数组；视为稠密数组，遇 `undefined` 即视为越过最后一层。
 * @param finalHandler - 越过全部中间件后执行的真实处理器。
 * @param signal - 最外层收到的取消信号；它只是第一层拿到的信号，逐层可被收窄或替换。
 * @returns 最外层中间件的返回值，即本次调用的终态结果。
 */
export function runWithMiddleware(
  info: RunInfo,
  middleware: readonly RunMiddleware[],
  finalHandler: RunHandler,
  signal: AbortSignal,
): Promise<RuntimeResult> {
  /** 进入第 `index` 层；越过最后一层时调用最终处理器。 */
  function dispatch(
    index: number,
    nextSignal: AbortSignal,
  ): Promise<RuntimeResult> {
    const current = middleware[index];
    if (current === undefined) return finalHandler(nextSignal);

    /** 当前层的下一跳；单独命名，让「进入下一层」在调用点可见。 */
    function runNext(innerSignal: AbortSignal): Promise<RuntimeResult> {
      return dispatch(index + 1, innerSignal);
    }

    return current(info, runNext, nextSignal);
  }

  return dispatch(0, signal);
}
