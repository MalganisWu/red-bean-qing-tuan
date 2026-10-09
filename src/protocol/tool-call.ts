/** 模型与 Runtime 之间传递的中性工具调用函数描述。 */
export interface ToolCallFunction {
  readonly name: string;
  readonly arguments: string;
}

/** 模型生成的中性工具调用，不包含具体 Dispatcher 行为。 */
export interface ToolCall {
  readonly index?: number | undefined;
  readonly id: string;
  readonly type: string;
  readonly function: ToolCallFunction;
}
