import type { JsonObject, JsonValue } from "../../../protocol/json.js";
import type { Tool, ToolResult, ToolSchema } from "../../definition/tool.js";
import { throwIfReadAborted } from "../read-file/safe-file-reader.js";
import {
  DEFAULT_SHELL_TIMEOUT_MS,
  MAX_SHELL_OUTPUT_BYTES,
  MAX_SHELL_TIMEOUT_MS,
} from "./shell-limits.js";
import {
  SHELL_TERMINATIONS,
  runShellCommand,
  type ShellRunRequest,
  type ShellRunResult,
} from "./shell-process.js";

/** 本工具在 Tool Registry 中的注册名；Agent 的 sys_tool_ids 用它引用，改名等于改变对外契约。 */
export const SHELL_TOOL_NAME = "sys_shell";

/** 调用方给出的执行条件，已通过运行时校验。 */
export interface ShellParams {
  /** 要交给 `bash -c` 执行的命令文本，已去除首尾空白且保证非空。 */
  readonly command: string;
  /** 5–10 词的动作描述，用于界面展示与事后审计；无法从命令文本推断，故必填。 */
  readonly description: string;
  /** 调用方指定的超时毫秒数；未提供时为 undefined，由工具默认值兜底。 */
  readonly timeoutMs: number | undefined;
  /** 命令的工作目录；未提供时为 undefined，回退到宿主进程当前目录。 */
  readonly workdir: string | undefined;
}

/** 工具实例配置；默认超时与输出上限可注入以便测试覆盖边界。 */
export interface ShellOptions {
  /** 未显式指定超时时使用的默认毫秒数；省略则取全局默认值。 */
  readonly defaultTimeoutMs?: number;
  /** 单个输出流的累积上限（字节）；省略则取全局上限。 */
  readonly maxOutputBytes?: number;
}

/**
 * 生成暴露给模型的 JSON Schema 入参描述。
 *
 * 说明文案里的超时数值由全局上限常量插值而来，保证模型看到的限制与实际执行时一致；
 * `command` 与 `description` 列为必填，其余字段可省略并由执行侧补默认值。
 *
 * @returns 描述 shell 工具入参的 JSON Schema 对象
 */
function parameters(): JsonObject {
  return {
    type: "object",
    properties: {
      command: {
        type: "string",
        description: "要执行的 bash 命令，等价于 bash -c <command>",
      },
      description: {
        type: "string",
        description:
          "5–10 词的动作描述，用于界面展示与事后审计，例如「运行后端测试」。命令本身的意图往往无法从文本看出，因此必须填写",
      },
      timeoutMs: {
        type: "number",
        description: `超时毫秒数，省略时用 ${DEFAULT_SHELL_TIMEOUT_MS}，最大值 ${MAX_SHELL_TIMEOUT_MS}`,
      },
      workdir: {
        type: "string",
        description: "命令的工作目录，省略时使用进程当前工作目录",
      },
    },
    required: ["command", "description"],
  };
}

/**
 * 从 unknown 形状的入参校验并归一化；缺 command 或 description 直接失败。
 *
 * @param value - 工具入参原始值，形状未知，需逐字段校验类型与取值范围
 * @returns 校验并归一化后的执行条件；任一字段非法时抛错
 */
function parseShellParams(value: JsonValue): ShellParams {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("shell 的参数必须是对象");
  }
  const rawCommand = value["command"];
  if (typeof rawCommand !== "string") throw new Error("command 必须是字符串");
  const command = rawCommand.trim();
  if (command === "") throw new Error("command 不能为空");

  const rawDescription = value["description"];
  if (typeof rawDescription !== "string") {
    throw new Error("description 必须是字符串");
  }
  const description = rawDescription.trim();
  if (description === "") throw new Error("description 不能为空");

  const rawTimeout = value["timeoutMs"];
  if (rawTimeout !== undefined && typeof rawTimeout !== "number") {
    throw new Error("timeoutMs 必须是数字");
  }
  if (
    rawTimeout !== undefined &&
    (!Number.isFinite(rawTimeout) || rawTimeout <= 0)
  ) {
    throw new Error("timeoutMs 必须是正数");
  }

  const rawWorkdir = value["workdir"];
  if (rawWorkdir !== undefined && typeof rawWorkdir !== "string") {
    throw new Error("workdir 必须是字符串");
  }
  const workdir = rawWorkdir === undefined ? undefined : rawWorkdir.trim();
  if (workdir !== undefined && workdir === "")
    throw new Error("workdir 不能为空");

  return { command, description, timeoutMs: rawTimeout, workdir };
}

/**
 * 组装结果文本：输出在前，结束原因在最后一行，便于模型先读内容再看成败。
 *
 * @param result - 命令执行结果，含分离的 stdout/stderr 与各自的截断标记
 * @param request - 对应的执行条件，用于在截断标记里回填具体的上限字节数
 * @returns 供模型阅读的合并文本，尾行为结束原因标记
 */
function formatShellResult(
  result: ShellRunResult,
  request: ShellRunRequest,
): string {
  const parts: string[] = [];
  const stdout = result.stdout.replace(/\n+$/u, "");
  if (stdout !== "") parts.push(stdout);
  if (result.stdoutTruncated) {
    parts.push(`[stdout truncated at ${request.maxOutputBytes} bytes]`);
  }
  const stderr = result.stderr.replace(/\n+$/u, "");
  if (stderr !== "") parts.push("[stderr]", stderr);
  if (result.stderrTruncated) {
    parts.push(`[stderr truncated at ${request.maxOutputBytes} bytes]`);
  }
  parts.push(terminationMarker(result, request));
  return parts.join("\n");
}

/**
 * 结束原因标记。
 *
 * 超时与取消不伪装成退出码：模型需要区分「命令失败了」与「命令没跑完」，两者的后续动作不同。
 *
 * @param result - 命令执行结果，据其 termination 与 exitCode/signal 决定标记文案
 * @param request - 对应的执行条件，用于在超时标记里回填实际的超时毫秒数
 * @returns 单行的结束原因标记文本
 */
function terminationMarker(
  result: ShellRunResult,
  request: ShellRunRequest,
): string {
  if (result.termination === SHELL_TERMINATIONS.TIMED_OUT) {
    return `[timed out after ${request.timeoutMs}ms; process group killed]`;
  }
  if (result.termination === SHELL_TERMINATIONS.ABORTED) {
    return "[aborted; process group killed]";
  }
  if (result.exitCode !== null) return `[exit code: ${result.exitCode}]`;
  return `[terminated by signal ${result.signal ?? "unknown"}]`;
}

/**
 * 执行 shell 命令的前台工具。
 *
 * 安全边界显著大于文件工具：这是任意命令执行，可以发起网络请求、安装依赖、启动进程，并且
 * **绕过全部文件闸门**（`sed -i`、`tee` 都不经过读取账本）。只在部署平台已提供进程级隔离时才是
 * 安全的。子进程继承宿主进程的完整环境变量，包括部署凭据。
 *
 * 本批只支持前台执行：需要长时间运行的命令会被超时终止，没有后台作业。
 */
export class ShellTool implements Tool {
  /** 本工具在 Tool Registry 中的注册名，与 `SHELL_TOOL_NAME` 保持一致。 */
  public readonly name = SHELL_TOOL_NAME;
  /** 工具契约：函数名、给模型的说明与 JSON Schema 入参。 */
  public readonly schema: ToolSchema = {
    type: "function",
    function: {
      name: this.name,
      description:
        "执行一条 bash 命令并返回输出与退出码，等价于 bash -c。用于运行测试、构建、格式化、版本控制等需要执行程序的场景。stdout 与 stderr 分开返回，结尾的 [exit code: N] 表示成败；超时或取消会终止整个进程组并给出相应标记。前台执行，没有后台作业，长命令请自行加超时。这是任意命令执行，会绕过文件工具的「先读后写」约束，且子进程继承宿主环境变量。",
      parameters: parameters(),
    },
  };
  /** 本实例未显式指定超时时使用的默认毫秒数。 */
  readonly #defaultTimeoutMs: number;
  /** 本实例中 stdout 与 stderr 各自的累积上限（字节）。 */
  readonly #maxOutputBytes: number;

  public constructor(options?: ShellOptions) {
    this.#defaultTimeoutMs =
      options?.defaultTimeoutMs ?? DEFAULT_SHELL_TIMEOUT_MS;
    this.#maxOutputBytes = options?.maxOutputBytes ?? MAX_SHELL_OUTPUT_BYTES;
  }

  /**
   * 前台执行一条 shell 命令。调用方给出的超时会被夹到全局上限内，输出按实例上限截断，
   * 超时或取消会终止整个进程组并以结束标记区分于普通退出码。
   *
   * @param value - 工具入参原始值，含 `command`、`description` 及可选 `timeoutMs`/`workdir`，尚未校验
   * @param _context - 未使用；保留以满足 `Tool` 契约
   * @param signal - 取消信号，中止时终止子进程组
   * @returns 组合了 stdout、stderr 与结束原因的文本
   */
  public async execute(
    value: JsonValue,
    _context: unknown,
    signal: AbortSignal,
  ): Promise<ToolResult> {
    throwIfReadAborted(signal);
    const params = parseShellParams(value);
    const request: ShellRunRequest = {
      command: params.command,
      workdir: params.workdir ?? process.cwd(),
      // 调用方给出的超时不得突破全局上限，否则工具可以绕过宿主设定的最长执行时间。
      timeoutMs: Math.min(
        params.timeoutMs ?? this.#defaultTimeoutMs,
        MAX_SHELL_TIMEOUT_MS,
      ),
      maxOutputBytes: this.#maxOutputBytes,
    };
    const result = await runShellCommand(request, signal);
    return { content: formatShellResult(result, request) };
  }

  /** 无常驻资源需要释放；保留以满足 `Tool` 契约。 */
  public close(): Promise<void> {
    return Promise.resolve();
  }
}
