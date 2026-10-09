import type { JsonObject } from "./json.js";

/** 可序列化的工具函数声明。 */
export interface ToolFunction {
  readonly name: string;
  readonly description: string;
  readonly parameters: JsonObject;
}

/** Runtime 工具声明；interrupting 是 Runtime 内部执行提示。 */
export interface ToolSchema {
  readonly type: string;
  readonly function: ToolFunction;
  readonly interrupting?: boolean | undefined;
}

/** 发送给模型的工具声明，不包含 Runtime 内部 metadata。 */
export interface LlmToolSchema {
  readonly type: string;
  readonly function: ToolFunction;
}
