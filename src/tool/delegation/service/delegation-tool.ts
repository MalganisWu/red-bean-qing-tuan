import type { ToolCallContext } from "../../../protocol/run-identity.js";
import {
  serializeInterrupt,
  type Interrupt,
} from "../../../protocol/interrupt.js";
import type { JsonObject, JsonValue } from "../../../protocol/json.js";
import type { Tool, ToolResult, ToolSchema } from "../../definition/tool.js";
import {
  CHILD_RUN_STATUSES,
  type ChildResume,
  type ChildRunRequest,
  type ChildRunResult,
  type ChildRunner,
} from "../runner/port/child-runner.js";
import { ChildRunError } from "../error/child-run-error.js";

export {
  CHILD_RUN_STATUSES,
  type ChildResume,
  type ChildRunRequest,
  type ChildRunResult,
  type ChildRunStatus,
  type ChildRunner,
} from "../runner/port/child-runner.js";
export { ChildRunError } from "../error/child-run-error.js";

/** 委派工具的构造配置；ChildRunner 的执行与持久化能力由宿主注入。 */
export interface DelegationToolOptions {
  readonly agentId: string;
  readonly name: string;
  readonly description?: string | undefined;
  readonly runner: ChildRunner;
}

interface DelegationParams {
  readonly instruction: string;
  readonly context: string;
  readonly expectedFormat: string;
  readonly executionId: string;
  readonly interruptId: string;
  readonly response: string | undefined;
}

function isRecord(value: JsonValue): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optionalString(params: JsonObject, key: string): string | undefined {
  const value = params[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") {
    throw new Error(`delegation parameter ${key} must be a string`);
  }
  return value;
}

function parseParams(value: JsonValue): DelegationParams {
  if (!isRecord(value))
    throw new Error("delegation parameters must be an object");
  return {
    instruction: optionalString(value, "instruction") ?? "",
    context: optionalString(value, "context") ?? "",
    expectedFormat: optionalString(value, "expected_format") ?? "",
    executionId: optionalString(value, "execution_id") ?? "",
    interruptId: optionalString(value, "interrupt_id") ?? "",
    response: optionalString(value, "response"),
  };
}

/**
 * 从参数里识别「这是一次恢复」。
 *
 * 三个字段构成一组，只能全有或全无，所以校验必须成组做而不是逐字段做：
 * 只有 response 没有 interrupt_id、有 interrupt_id 却没有 execution_id、
 * 或反过来缺 response，都是模型拼错了参数。这里直接抛错而不是悄悄降级成一次新委派——
 * 把续跑误当成新对话会重复执行整个任务。
 *
 * 注意 `response` 判的是 `undefined` 而非空串：**空字符串是有效回答**（例如用户什么都没填就确认）。
 */
function childResumeFromParams(
  params: DelegationParams,
): ChildResume | undefined {
  const interruptId = params.interruptId.trim();
  if (interruptId === "") {
    if (params.response !== undefined) {
      throw new Error("恢复参数 response 必须与 interrupt_id 一起提供");
    }
    return undefined;
  }
  if (params.executionId.trim() === "") {
    throw new Error("恢复参数 interrupt_id 必须与 execution_id 一起提供");
  }
  if (params.response === undefined) {
    throw new Error("恢复参数 interrupt_id 必须提供 response");
  }
  return { interruptId, response: params.response };
}

function failure(
  reason: string,
  executionId: string,
  partialOutput: string,
): string {
  const payload: Record<string, JsonValue> = {
    status: "failed",
    error: reason,
    execution_id: executionId,
  };
  if (partialOutput !== "") payload["partial_output"] = partialOutput;
  return JSON.stringify(payload);
}

function suspended(executionId: string, interrupt: Interrupt): string {
  return JSON.stringify({
    status: "awaiting_user",
    execution_id: executionId,
    interrupt_id: interrupt.toolCallId,
    interrupt: serializeInterrupt(interrupt),
  });
}

const DELEGATION_PARAMETERS: JsonObject = {
  type: "object",
  properties: {
    instruction: {
      type: "string",
      description: "任务描述（新对话必填；续跑时可选）",
    },
    context: { type: "string", description: "相关上下文信息（可选）" },
    expected_format: {
      type: "string",
      description: "期望返回的数据格式（可选）",
    },
    execution_id: {
      type: "string",
      description: "续跑时传入的执行记录 ID",
    },
    interrupt_id: {
      type: "string",
      description: "恢复挂起运行时传入的中断 ID",
    },
    response: {
      type: "string",
      description: "对 interrupt_id 的回答；空字符串也是有效回答",
    },
  },
  required: [],
};

/** 将通用 Tool 调用映射为宿主 ChildRunner 请求，并规范化完成、挂起与失败结果。 */
export class DelegationTool implements Tool {
  public readonly name: string;
  public readonly schema: ToolSchema;
  readonly #agentId: string;
  readonly #runner: ChildRunner;

  public constructor(options: DelegationToolOptions) {
    if (options.agentId.trim() === "") {
      throw new Error("delegation agent ID must not be empty");
    }
    if (options.name.trim() === "") {
      throw new Error("delegation tool name must not be empty");
    }
    if (!options.runner || typeof options.runner.runChild !== "function") {
      throw new Error("delegation child runner must be configured");
    }
    this.#agentId = options.agentId;
    this.name = options.name;
    this.#runner = options.runner;
    this.schema = {
      type: "function",
      function: {
        name: options.name,
        description: options.description ?? "",
        parameters: DELEGATION_PARAMETERS,
      },
    };
  }

  /**
   * 执行一次委派或续跑。
   *
   * 结果为**给模型看的 JSON 文本**，不是给用户的展示文案——这正是失败与挂起都不抛异常、
   * 而是序列化成 `{"status": ...}` 的原因：父 Agent 需要把「子任务失败了」当作一次普通的
   * 工具结果读进去，再决定重试、换法子还是向用户报告。真正抛出的只有参数本身不合法。
   *
   * 另外两处刻意的严格：
   * - 续跑返回的 `executionId` 必须与请求一致，否则父子会挂到不同的执行记录上。
   * - `completed` 但输出为空也算失败：子 Agent 什么都没说，父 Agent 无从继续。
   */
  public async execute(
    value: JsonValue,
    context: ToolCallContext,
    signal: AbortSignal,
  ): Promise<ToolResult> {
    const params = parseParams(value);
    const resume = childResumeFromParams(params);
    if (params.executionId === "" && params.instruction.trim() === "") {
      throw new Error("新对话委派必须提供 instruction（任务描述）");
    }
    const request: ChildRunRequest = {
      agentId: this.#agentId,
      executionId: params.executionId,
      parentCallId: context.callId,
      threadId: context.threadId,
      userId: context.userId,
      requestId: context.requestId,
      traceId: context.traceId,
      instruction: params.instruction,
      context: params.context,
      expectedFormat: params.expectedFormat,
      ...(resume ? { resume } : {}),
      ...(context.eventSink ? { eventSink: context.eventSink } : {}),
    };

    let child: ChildRunResult;
    let runError: Error | undefined;
    try {
      child = await this.#runner.runChild(request, signal);
    } catch (cause: unknown) {
      runError = cause instanceof Error ? cause : new Error(String(cause));
      // ChildRunError 带着宿主失败那一刻的部分结果，比一个光秃秃的 FAILED 信息量大得多，
      // 所以优先采用它；其他异常只能退回最小结果。
      child =
        cause instanceof ChildRunError
          ? cause.result
          : { status: CHILD_RUN_STATUSES.FAILED };
    }
    // 续跑的身份校验：回来的必须还是那一次执行。
    if (
      request.executionId !== "" &&
      child.executionId !== undefined &&
      child.executionId !== "" &&
      child.executionId !== request.executionId
    ) {
      return {
        content: failure(
          `子 Agent 返回的 execution_id ${JSON.stringify(child.executionId)} 与续跑请求 ${JSON.stringify(request.executionId)} 不一致`,
          request.executionId,
          child.partialOutput ?? "",
        ),
      };
    }
    const executionId = child.executionId ?? request.executionId;
    if (runError) {
      return {
        content: failure(
          runError.message,
          executionId,
          child.partialOutput ?? child.output ?? "",
        ),
      };
    }
    // 三种终局各自映射成模型可读的结果。挂起是唯一「不算失败也不算完成」的分支。
    switch (child.status) {
      case CHILD_RUN_STATUSES.COMPLETED:
        // 跑完了却没有输出，对父 Agent 而言等于失败：它拿不到任何可用于继续的信息。
        if ((child.output ?? "") === "") {
          return {
            content: failure(
              "子 Agent 执行完成，但未产生有效输出",
              executionId,
              "",
            ),
          };
        }
        // 把 execution_id 附在正文末尾，是父 Agent 日后续跑该子任务的唯一线索。
        return {
          content:
            executionId === ""
              ? (child.output ?? "")
              : `${child.output ?? ""}\n\n[execution_id: ${executionId}]`,
        };
      case CHILD_RUN_STATUSES.SUSPENDED:
        // 挂起必须三样齐全才能交给父 Agent：执行 ID（去哪续）、interrupt（回什么）、
        // toolCallId（恢复时匹配用）。缺任何一样都无法恢复，只能在子运行那里堵住。
        if (executionId === "") {
          return {
            content: failure(
              "子 Agent 挂起但未返回 execution_id",
              "",
              child.partialOutput ?? "",
            ),
          };
        }
        if (!child.interrupt) {
          return {
            content: failure(
              "子 Agent 挂起但未返回 interrupt",
              executionId,
              child.partialOutput ?? "",
            ),
          };
        }
        if (child.interrupt.toolCallId.trim() === "") {
          return {
            content: failure(
              "子 Agent 挂起结果的 interrupt 缺少 tool_call_id",
              executionId,
              child.partialOutput ?? "",
            ),
          };
        }
        return { content: suspended(executionId, child.interrupt) };
      // 三种非正常结束走同一条映射：有 error 就用宿主的原文，没有就退回状态名。
      // partial_output 一并带上，父 Agent 有时能靠半成品继续，而不必整段重做。
      case CHILD_RUN_STATUSES.FAILED:
      case CHILD_RUN_STATUSES.CANCELLED:
      case CHILD_RUN_STATUSES.EXHAUSTED:
        return {
          content: failure(
            child.error ?? `子 Agent 执行未完成（${child.status}）`,
            executionId,
            child.partialOutput ?? "",
          ),
        };
    }
  }
}
