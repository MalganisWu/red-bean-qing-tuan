import type { LlmAdapter } from "../../../llm/adapter/port/llm-adapter.js";
import type { ModelParams } from "../../../llm/model/model.js";
import type { RuntimeConfig } from "../../../pipeline/config/runtime-config.js";
import type { MessageHook } from "../../../pipeline/hook/port/message-hook.js";
import type { InterruptAssembler } from "../../../pipeline/interrupt/port/interrupt-assembler.js";
import type { ToolSchema } from "../../../protocol/tool-schema.js";
import type { ToolDispatcher } from "../../../tool/dispatcher/port/tool-dispatcher.js";
import type { CheckpointStore } from "../../checkpoint/store/port/checkpoint-store.js";
import type { EventSink, EventSinkErrorPolicy } from "./runtime-run-options.js";

/** Runtime 组装完成后的不可变能力图，不包含任何产品业务 DTO。 */
export interface RuntimeConfiguration {
  /** 组装后选定的 LLM 适配器，已被插件中间件逐层包好。 */
  readonly model: LlmAdapter;
  /** 组装后的工具分发器，已应用 Tool 中间件与授权策略。 */
  readonly dispatcher: ToolDispatcher;
  /** 暴露给模型的工具 schema 列表，只含宿主显式授权的工具。 */
  readonly tools: readonly ToolSchema[];
  /** 拼装后的系统提示词；空串表示未提供。 */
  readonly systemPrompt: string;
  /** 传给模型的采样参数（温度、上限等），未设置时为默认值。 */
  readonly modelParams: ModelParams;
  /** Pipeline 层的运行时配置（循环上限、压缩阈值等）。 */
  readonly runtimeConfig: RuntimeConfig;
  /** 持久化 Checkpoint 的 Store；undefined 表示无 Store 模式，幂等与状态改由进程内收据承担。 */
  readonly store: CheckpointStore | undefined;
  /** 事件接收端；undefined 表示不消费本次运行产生的事件。 */
  readonly eventSink: EventSink | undefined;
  /** 事件发布失败时的处置策略（忽略或上抛）。 */
  readonly eventPolicy: EventSinkErrorPolicy;
  /** 消息钩子；undefined 表示不在消息边界插入处理。 */
  readonly messageHook: MessageHook | undefined;
  /** 中断装配器；undefined 表示本次运行不使用中断。 */
  readonly interruptAssembler: InterruptAssembler | undefined;
}
