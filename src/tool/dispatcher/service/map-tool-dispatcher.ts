import { toJsonValue, type JsonValue } from "../../../protocol/json.js";
import type { ToolCall } from "../../../protocol/tool-call.js";
import type { ToolCallContext } from "../../../protocol/run-identity.js";
import type { Tool, ToolResult } from "../../definition/tool.js";
import type { ToolDispatcher } from "../port/tool-dispatcher.js";

/**
 * 分发阶段的稳定错误码。
 * `NOT_FOUND` 尤其重要：组合分发器（见产品侧的 CompositeDispatcher）靠它判断
 * 「这个工具不在这张表里，去另一张表找」，而不是靠消息文本匹配。
 */
export const TOOL_DISPATCH_ERROR_CODES = Object.freeze({
  NOT_FOUND: "tool_not_found",
  INVALID_ARGUMENTS: "invalid_tool_arguments",
} as const);

/** 工具分发阶段可稳定识别的错误码。 */
export type ToolDispatchErrorCode =
  (typeof TOOL_DISPATCH_ERROR_CODES)[keyof typeof TOOL_DISPATCH_ERROR_CODES];

/** 分发失败的稳定类型；`code` 是供机器分支的判据，消息只供人读。 */
export class ToolDispatchError extends Error {
  /** 分发阶段的稳定错误码；供组合分发器机器分支，消息文本仅供人读。 */
  public readonly code: ToolDispatchErrorCode;

  public constructor(
    code: ToolDispatchErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "ToolDispatchError";
    this.code = code;
  }
}

/**
 * 把模型给出的参数文本解析为 JSON 值。
 *
 * 空串与字面量 `"null"` 都归一为 `{}`：模型常以这两种写法表达「无参数」，
 * 若原样交给 JSON.parse 会得到 `null`，让下游按对象取值时报错。
 * 解析结果再经 `toJsonValue` 过一遍，确保进入 Runtime 的 JSON 值域。
 *
 * @param argumentsJson - 工具调用携带的原始参数字符串。
 * @returns 已归一化的 JSON 值；空串与 `"null"` 返回空对象。
 * @throws ToolDispatchError 参数不是合法 JSON 或落在 JSON 值域之外时抛出，错误码为 `INVALID_ARGUMENTS`。
 */
function parseArguments(argumentsJson: string): JsonValue {
  if (argumentsJson === "" || argumentsJson === "null") return {};
  let value: unknown;
  try {
    value = JSON.parse(argumentsJson);
  } catch (cause: unknown) {
    const error = cause instanceof Error ? cause : undefined;
    throw new ToolDispatchError(
      TOOL_DISPATCH_ERROR_CODES.INVALID_ARGUMENTS,
      "tool arguments are not valid JSON",
      error ? { cause: error } : undefined,
    );
  }
  return toJsonValue(value);
}

/** 按稳定工具名查找并执行显式注册 Tool 的默认分发器。 */
export class MapToolDispatcher implements ToolDispatcher {
  /** 工具名到 Tool 的注册表；构造时一次性填充，运行期不再变化。 */
  readonly #tools = new Map<string, Tool>();

  public constructor(tools: readonly Tool[]) {
    for (const tool of tools) this.#tools.set(tool.name, tool);
  }

  /**
   * 按工具名查找并执行显式注册的 Tool。
   *
   * 找不到工具或参数不是合法 JSON 时都不抛异常，而是返回**被拒绝的 Promise**——
   * 这正是组合分发器靠 `NOT_FOUND` 决定「换下一张表」的判据来源。
   *
   * @param call - 模型给出的工具调用；其 `function.name` 是查表键，未注册时以 `NOT_FOUND` 拒绝。
   * @param context - 透传给目标 Tool 的调用上下文。
   * @param signal - 透传给目标 Tool 的取消信号。
   * @returns 目标 Tool 的执行结果；工具未注册或参数解析失败时以 `ToolDispatchError` 拒绝。
   */
  public dispatch(
    call: ToolCall,
    context: ToolCallContext,
    signal: AbortSignal,
  ): Promise<ToolResult> {
    const tool = this.#tools.get(call.function.name);
    if (!tool) {
      return Promise.reject(
        new ToolDispatchError(
          TOOL_DISPATCH_ERROR_CODES.NOT_FOUND,
          `tool ${JSON.stringify(call.function.name)} is not registered`,
        ),
      );
    }
    let params: JsonValue;
    try {
      params = parseArguments(call.function.arguments);
    } catch (error: unknown) {
      return Promise.reject(
        error instanceof Error
          ? error
          : new ToolDispatchError(
              TOOL_DISPATCH_ERROR_CODES.INVALID_ARGUMENTS,
              "tool arguments are invalid",
            ),
      );
    }
    return tool.execute(params, context, signal);
  }
}

/** 未配置工具时的拒绝式实现，避免静默吞掉模型产生的 Tool Call。 */
export class NoopToolDispatcher implements ToolDispatcher {
  /**
   * 恒以 `NOT_FOUND` 拒绝，绝不静默吞掉模型产生的 Tool Call。
   *
   * @param call - 被拒绝的工具调用，仅用于错误消息里的工具名。
   * @returns 永远被拒绝的 Promise，附带 `NOT_FOUND` 错误码供上层判定。
   */
  public dispatch(call: ToolCall): Promise<ToolResult> {
    return Promise.reject(
      new ToolDispatchError(
        TOOL_DISPATCH_ERROR_CODES.NOT_FOUND,
        `tool ${JSON.stringify(call.function.name)} is not registered`,
      ),
    );
  }
}
