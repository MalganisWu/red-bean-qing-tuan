import type { RuntimeRunService } from "./run/port/runtime-run-service.js";
import { DefaultRuntimeRunService } from "./run/service/default-runtime-run-service.js";
import type { AgentRuntimeOptions } from "./run/model/runtime-run-options.js";
import { ReactAgentExecution } from "../pipeline/execution/service/react-agent-execution.js";
import { createRuntimeControlPlane } from "./control-plane-composition.js";
import type { RuntimeConfiguration } from "./run/model/runtime-configuration.js";
import { type ToolPolicy } from "./run/model/runtime-run-options.js";
import { EVENT_SINK_ERROR_POLICIES } from "./run/event-sink-error-policy.js";
import {
  installPlugins,
  type PluginRegistry,
  type RunMiddleware,
} from "./plugin/runtime-plugin.js";
import type { ToolCallContext } from "../protocol/run-identity.js";
import type {
  ToolCall,
  ToolResult,
  ToolSchema,
} from "../tool/definition/tool.js";
import type { ToolDispatcher } from "../tool/dispatcher/port/tool-dispatcher.js";
import {
  MapToolDispatcher,
  NoopToolDispatcher,
} from "../tool/dispatcher/service/map-tool-dispatcher.js";

export {
  createRuntimeControlPlane,
  type RuntimeControlPlane,
} from "./control-plane-composition.js";

/** 组装完成、等待绑定 control plane 的中间结构；只在本文件内流转，不对外暴露。 */
interface ConfiguredRuntime {
  /** 组装完成的能力图（模型、分发器、工具、Store、事件出口等）。 */
  readonly configuration: RuntimeConfiguration;
  /** 已封闭的插件注册表；服务仅用它关闭插件。 */
  readonly plugins: PluginRegistry;
  /** 从注册表取出的 run 中间件快照。 */
  readonly runMiddleware: readonly RunMiddleware[];
}

/**
 * 组装入口集中选择 SDK 默认实现，业务代码不会隐藏具体绑定关系。
 *
 * 包装顺序是这个函数的实质内容，且**不可调换**：
 * 1. 先由插件包装 ToolDispatcher（`plugins.wrapToolDispatcher`）；
 * 2. **再把 ToolPolicy 套在最外层**。
 *
 * 顺序反过来，插件就在授权策略之外，一次拒绝授权仍然会走到真实工具——
 * 这正是「任何插件都不能短路 ToolPolicy」这条承诺的实现方式。
 *
 * 工具与 toolDispatcher 是互斥的两条接入方式：前者由 SDK 建默认分发器，
 * 后者由宿主完全接管，同时给会让人无法判断该用哪个。
 *
 * @param options - 宿主传入的门面选项；tools 与 toolDispatcher 互斥，toolSchemas 与 toolDispatcher 必须成对出现
 * @returns 组装完成但尚未绑定 control plane 的中间结构
 */
function configureRuntime(options: AgentRuntimeOptions): ConfiguredRuntime {
  const tools = [...(options.tools ?? [])];
  const schemas: ToolSchema[] = [];
  const names = new Set<string>();
  for (const tool of tools) {
    if (tool.name === "" || tool.schema.function.name !== tool.name) {
      throw new Error(
        `tool name ${JSON.stringify(tool.name)} does not match schema name ${JSON.stringify(tool.schema.function.name)}`,
      );
    }
    if (names.has(tool.name)) {
      throw new Error(`duplicate tool ${JSON.stringify(tool.name)}`);
    }
    names.add(tool.name);
    schemas.push(tool.schema);
  }
  if (
    (options.toolSchemas === undefined) !==
    (options.toolDispatcher === undefined)
  ) {
    throw new Error(
      "toolSchemas and toolDispatcher must be configured together",
    );
  }
  if (tools.length > 0 && options.toolDispatcher) {
    throw new Error("tools and toolDispatcher are mutually exclusive");
  }

  // 没有显式 dispatcher 时：有工具就用 Map 分发器，一个工具都没有则用 Noop
  // （空工具集是合法的，模型只是没有工具可调）。
  let dispatcher: ToolDispatcher =
    options.toolDispatcher ??
    (tools.length > 0
      ? new MapToolDispatcher(tools)
      : new NoopToolDispatcher());
  const plugins = installPlugins(options.plugins ?? []);
  const model = plugins.wrapLlm(options.model);
  dispatcher = plugins.wrapToolDispatcher(dispatcher);
  // 策略放在插件**之后**包装，因此位于最外层，见函数注释。
  if (options.toolPolicy) {
    dispatcher = new PolicyDispatcher(dispatcher, options.toolPolicy);
  }
  const eventPolicy =
    options.eventSinkErrorPolicy ?? EVENT_SINK_ERROR_POLICIES.FAIL_FAST;
  if (!Object.values(EVENT_SINK_ERROR_POLICIES).includes(eventPolicy)) {
    throw new Error(
      `unknown event sink error policy ${JSON.stringify(eventPolicy)}`,
    );
  }
  return {
    configuration: {
      model,
      dispatcher,
      tools: options.toolSchemas ? [...options.toolSchemas] : schemas,
      systemPrompt: options.systemPrompt ?? "",
      modelParams: options.modelParams ?? {},
      runtimeConfig: options.runtimeConfig ?? {},
      store: options.checkpointStore,
      eventSink: options.eventSink,
      eventPolicy,
      messageHook: options.messageHook,
      interruptAssembler: options.interruptAssembler,
    },
    plugins,
    runMiddleware: plugins.runMiddleware(),
  };
}

/**
 * 在默认 ToolDispatcher 外执行宿主授权策略，拒绝后不会调用真实工具。
 * 策略抛出的异常会被包装并带上工具名——宿主只知道「策略拒绝了」，排障时需要知道是哪个工具。
 */
class PolicyDispatcher implements ToolDispatcher {
  /** 内层真实分发器（已被插件包过）；授权通过后才由它执行工具。 */
  readonly #next: ToolDispatcher;
  /** 宿主授权策略；抛错即拒绝，本层负责把拒绝翻译成带工具名的错误。 */
  readonly #policy: ToolPolicy;

  public constructor(next: ToolDispatcher, policy: ToolPolicy) {
    this.#next = next;
    this.#policy = policy;
  }

  /**
   * 先经宿主授权策略，通过后再委派内层分发器执行工具。
   *
   * 未授权时策略抛错，本层把它包装成携带工具名的错误再抛出，且不会调用内层——
   * 这正是「任何插件都不能短路 ToolPolicy」的落点。
   *
   * @param call - 待执行的工具调用
   * @param context - 工具调用上下文（线程、请求、追踪标识）
   * @param signal - 调用方取消信号；先传给策略，再透传给内层
   * @returns 内层返回的工具结果；未授权时抛错而不调用内层
   */
  public async dispatch(
    call: ToolCall,
    context: ToolCallContext,
    signal: AbortSignal,
  ): Promise<ToolResult> {
    try {
      await this.#policy.authorize(call, context, signal);
    } catch (cause: unknown) {
      const error = cause instanceof Error ? cause : new Error(String(cause));
      throw new Error(
        `tool ${JSON.stringify(call.function.name)} denied by policy: ${error.message}`,
        { cause },
      );
    }
    return this.#next.dispatch(call, context, signal);
  }
}

/**
 * AgentRuntime 公开门面的唯一默认实现绑定；改默认实现只需要改这一处。
 * @param options - 宿主传入的门面选项；tools 与 toolDispatcher 互斥，toolSchemas 与 toolDispatcher 必须成对出现。
 * @returns 已装配完成的 RuntimeRunService，可直接交给 AgentRuntime 使用。
 */
export function createRuntimeRunService(
  options: AgentRuntimeOptions,
): RuntimeRunService {
  const configured = configureRuntime(options);
  const controls = createRuntimeControlPlane();
  const execution = new ReactAgentExecution({
    adapter: configured.configuration.model,
    dispatcher: configured.configuration.dispatcher,
    tools: configured.configuration.tools,
    hook: configured.configuration.messageHook,
    systemPrompt: configured.configuration.systemPrompt,
    modelParams: configured.configuration.modelParams,
    config: configured.configuration.runtimeConfig,
    interruptAssembler: configured.configuration.interruptAssembler,
  });
  return new DefaultRuntimeRunService({
    configuration: configured.configuration,
    plugins: configured.plugins,
    runMiddleware: configured.runMiddleware,
    lifecycle: controls.lifecycle,
    threadExecution: controls.threadExecution,
    resumeReceipts: controls.resumeReceipts,
    execution,
  });
}
