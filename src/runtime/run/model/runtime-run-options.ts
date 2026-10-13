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
  /**
   * 发布一条运行事件。
   *
   * @param event - 中性运行事件；实现负责传输、排队与落库，不得反向影响运行语义
   */
  publish(event: RuntimeEvent): void;
}

/**
 * 工具分发前的授权边界；未授权必须抛错并阻止执行。
 * 契约是「抛错即拒绝」——返回而不抛一律视为放行，因此实现里不能靠返回值表达拒绝。
 * 这一层位于所有插件之外（见 runtime-composition 的包装顺序），插件无法绕过它。
 */
export interface ToolPolicy {
  /**
   * 校验一次工具调用是否被授权；抛错即拒绝执行。
   *
   * @param call - 待授权的工具调用
   * @param context - 调用上下文（线程、请求、追踪标识）
   * @param signal - 调用方取消信号；授权判定应尽快响应取消
   */
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
  /** 必填的 LLM 适配器；插件中间件会在构造期包在它外层。 */
  readonly model: LlmAdapter;
  /** 宿主提供的工具清单，由 SDK 建默认分发器；与 toolSchemas+toolDispatcher 互斥，缺省则无工具。 */
  readonly tools?: readonly Tool[] | undefined;
  /** 交给默认分发器的工具 schema；必须与 toolDispatcher 成对出现。 */
  readonly toolSchemas?: readonly ToolSchema[] | undefined;
  /** 宿主完全接管的工具分发器；必须与 toolSchemas 成对出现。 */
  readonly toolDispatcher?: ToolDispatcher | undefined;
  /** 系统提示词；省略则不注入系统消息。 */
  readonly systemPrompt?: string | undefined;
  /** 传给模型的采样参数；省略则使用默认值。 */
  readonly modelParams?: ModelParams | undefined;
  /** Pipeline 运行时配置（循环上限、压缩阈值等）。 */
  readonly runtimeConfig?: RuntimeConfig | undefined;
  /** 持久化 Store；省略即无 Store 模式，此时 state/history 才是合法输入形态。 */
  readonly checkpointStore?: CheckpointStore | undefined;
  /** 事件接收端；省略表示不消费运行事件。 */
  readonly eventSink?: EventSink | undefined;
  /** 事件出口失败时的处置策略；省略默认 `fail_fast`。 */
  readonly eventSinkErrorPolicy?: EventSinkErrorPolicy | undefined;
  /** 工具授权边界；省略表示不额外拦截，但内置文件与网络工具仍保持 fail-closed。 */
  readonly toolPolicy?: ToolPolicy | undefined;
  /** 静态插件清单；构造期注册后注册表立即封闭，运行期不再变化。 */
  readonly plugins?: readonly RuntimePlugin[] | undefined;
  /** 观察每条已提交消息，供宿主实现增量故障保护；Runtime 不感知其存储方式。 */
  readonly messageHook?: MessageHook | undefined;
  /** 将中性 interrupt 投影到宿主表现层；不得在实现中反向持有业务 Repository。 */
  readonly interruptAssembler?: InterruptAssembler | undefined;
}
