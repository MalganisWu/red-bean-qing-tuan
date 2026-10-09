import { toJsonValue, type JsonValue } from "../../../protocol/json.js";
import type { ToolCall } from "../../../protocol/tool-call.js";
import type { ToolCallContext } from "../../../protocol/run-identity.js";
import type { Tool, ToolResult } from "../../definition/tool.js";
import type { ToolDispatcher } from "../port/tool-dispatcher.js";

export const TOOL_DISPATCH_ERROR_CODES = Object.freeze({
  NOT_FOUND: "tool_not_found",
  INVALID_ARGUMENTS: "invalid_tool_arguments",
} as const);

/** 工具分发阶段可稳定识别的错误码。 */
export type ToolDispatchErrorCode =
  (typeof TOOL_DISPATCH_ERROR_CODES)[keyof typeof TOOL_DISPATCH_ERROR_CODES];

export class ToolDispatchError extends Error {
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
  readonly #tools = new Map<string, Tool>();

  public constructor(tools: readonly Tool[]) {
    for (const tool of tools) this.#tools.set(tool.name, tool);
  }

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
  public dispatch(call: ToolCall): Promise<ToolResult> {
    return Promise.reject(
      new ToolDispatchError(
        TOOL_DISPATCH_ERROR_CODES.NOT_FOUND,
        `tool ${JSON.stringify(call.function.name)} is not registered`,
      ),
    );
  }
}
