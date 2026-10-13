import type { JsonObject } from "./json.js";

/** 可序列化的工具函数声明。 */
export interface ToolFunction {
  /** 函数名，模型调用时按此名回指。 */
  readonly name: string;
  /** 面向模型的自然语言说明，描述何时使用该工具。 */
  readonly description: string;
  /** JSON Schema 形式的参数声明；必须是普通 JSON 对象，不含 Runtime 内部字段。 */
  readonly parameters: JsonObject;
}

/** Runtime 工具声明；interrupting 是 Runtime 内部执行提示。 */
export interface ToolSchema {
  /** 工具类型标签，沿用 OpenAI 的 `function`。 */
  readonly type: string;
  /** 函数声明，含名字、说明与参数 Schema。 */
  readonly function: ToolFunction;
  /** Runtime 内部执行提示：为真表示该工具可能中断并等待宿主恢复；不发给模型。 */
  readonly interrupting?: boolean | undefined;
}

/** 发送给模型的工具声明，不包含 Runtime 内部 metadata。 */
export interface LlmToolSchema {
  /** 工具类型标签，沿用 OpenAI 的 `function`。 */
  readonly type: string;
  /** 函数声明，含名字、说明与参数 Schema；与 `ToolSchema` 共用同一结构。 */
  readonly function: ToolFunction;
}
