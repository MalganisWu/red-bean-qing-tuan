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
  readonly model: LlmAdapter;
  readonly dispatcher: ToolDispatcher;
  readonly tools: readonly ToolSchema[];
  readonly systemPrompt: string;
  readonly modelParams: ModelParams;
  readonly runtimeConfig: RuntimeConfig;
  readonly store: CheckpointStore | undefined;
  readonly eventSink: EventSink | undefined;
  readonly eventPolicy: EventSinkErrorPolicy;
  readonly messageHook: MessageHook | undefined;
  readonly interruptAssembler: InterruptAssembler | undefined;
}
