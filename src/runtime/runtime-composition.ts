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

interface ConfiguredRuntime {
  readonly configuration: RuntimeConfiguration;
  readonly plugins: PluginRegistry;
  readonly runMiddleware: readonly RunMiddleware[];
}

/** 组装入口集中选择 SDK 默认实现，业务代码不会隐藏具体绑定关系。 */
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

  let dispatcher: ToolDispatcher =
    options.toolDispatcher ??
    (tools.length > 0
      ? new MapToolDispatcher(tools)
      : new NoopToolDispatcher());
  const plugins = installPlugins(options.plugins ?? []);
  const model = plugins.wrapLlm(options.model);
  dispatcher = plugins.wrapToolDispatcher(dispatcher);
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

/** 在默认 ToolDispatcher 外执行宿主授权策略，拒绝后不会调用真实工具。 */
class PolicyDispatcher implements ToolDispatcher {
  readonly #next: ToolDispatcher;
  readonly #policy: ToolPolicy;

  public constructor(next: ToolDispatcher, policy: ToolPolicy) {
    this.#next = next;
    this.#policy = policy;
  }

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

/** AgentRuntime 公开门面的唯一默认实现绑定。 */
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
