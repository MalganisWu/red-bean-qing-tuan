import type { LlmAdapter } from "../../../llm/adapter/port/llm-adapter.js";
import type { ModelParams } from "../../../llm/model/model.js";
import type { RuntimeEvent } from "../../../protocol/event.js";
import type { RuntimeConfig } from "../../../pipeline/config/runtime-config.js";
import type { MessageHook } from "../../../pipeline/hook/port/message-hook.js";
import type { InterruptAssembler } from "../../../pipeline/interrupt/port/interrupt-assembler.js";
import type { ToolCallContext } from "../../../protocol/run-identity.js";
import type { ToolCall } from "../../../protocol/tool-call.js";
import type { ToolSchema } from "../../../protocol/tool-schema.js";
import type { Tool } from "../../../tool/definition/tool.js";
import type { ToolDispatcher } from "../../../tool/dispatcher/port/tool-dispatcher.js";
import type { CheckpointStore } from "../../checkpoint/store/port/checkpoint-store.js";
import type { RuntimePlugin } from "../../../runtime/plugin/runtime-plugin.js";

/**
 * 宿主事件出口失败时的运行处置策略。
 * - `fail_fast`（默认）：出口一坏就中止本次运行，避免产出一段没人看得到的执行。
 * - `ignore`：吞掉出口错误，运行照常走完——适合把观测当作完全可丢弃的旁路。
 */
export type EventSinkErrorPolicy = "fail_fast" | "ignore";

/** 中性事件出口；传输、排队和落库由宿主实现。 */
export interface EventSink {
  publish(event: RuntimeEvent): void;
}

/**
 * 工具分发前的授权边界；未授权必须抛错并阻止执行。
 * 契约是「抛错即拒绝」——返回而不抛一律视为放行，因此实现里不能靠返回值表达拒绝。
 * 这一层位于所有插件之外（见 runtime-composition 的包装顺序），插件无法绕过它。
 */
export interface ToolPolicy {
  authorize(
    call: ToolCall,
    context: ToolCallContext,
    signal: AbortSignal,
  ): Promise<void>;
}

/**
 * 构造 AgentRuntime 的宿主配置；所有对象在构造期固定。
 *
 * 两组字段互斥，同时提供会直接抛错（由 configureRuntime 校验）：
 * - `tools` 与 `toolSchemas` + `toolDispatcher`：前者让 SDK 建默认分发器，后者由宿主完全接管。
 *   注意 `toolSchemas` 与 `toolDispatcher` 必须成对出现。
 * - 无 `checkpointStore` 时，`state` / `history` 才是合法的输入形态；
 *   有 Store 时由 Store 持有状态，具体约束见 runtime-request-validator。
 */
export interface AgentRuntimeOptions {
  readonly model: LlmAdapter;
  readonly tools?: readonly Tool[] | undefined;
  readonly toolSchemas?: readonly ToolSchema[] | undefined;
  readonly toolDispatcher?: ToolDispatcher | undefined;
  readonly systemPrompt?: string | undefined;
  readonly modelParams?: ModelParams | undefined;
  readonly runtimeConfig?: RuntimeConfig | undefined;
  readonly checkpointStore?: CheckpointStore | undefined;
  readonly eventSink?: EventSink | undefined;
  readonly eventSinkErrorPolicy?: EventSinkErrorPolicy | undefined;
  readonly toolPolicy?: ToolPolicy | undefined;
  readonly plugins?: readonly RuntimePlugin[] | undefined;
  /** 观察每条已提交消息，供宿主实现增量故障保护；Runtime 不感知其存储方式。 */
  readonly messageHook?: MessageHook | undefined;
  /** 将中性 interrupt 投影到宿主表现层；不得在实现中反向持有业务 Repository。 */
  readonly interruptAssembler?: InterruptAssembler | undefined;
}
