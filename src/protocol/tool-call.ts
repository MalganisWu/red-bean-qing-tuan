/** 模型与 Runtime 之间传递的中性工具调用函数描述。 */
export interface ToolCallFunction {
  /** 函数名，对应工具的 `Tool.name`。 */
  readonly name: string;
  /** 模型生成的原始参数 JSON 文本；未解析，可能是非法 JSON，由调用方负责校验。 */
  readonly arguments: string;
}

/** 模型生成的中性工具调用，不包含具体 Dispatcher 行为。 */
export interface ToolCall {
  /** 流式分片内的调用序号，用于把同一 tool_calls 数组的多个分片归并到同一次调用；`0` 与未设置等价。 */
  readonly index?: number | undefined;
  /** 调用唯一标识，由模型给出，用于把结果消息回指到本次调用。 */
  readonly id: string;
  /** 调用类型标签，沿用 OpenAI 的 `function`。 */
  readonly type: string;
  /** 函数名与原始参数，保持中性不解析。 */
  readonly function: ToolCallFunction;
}
