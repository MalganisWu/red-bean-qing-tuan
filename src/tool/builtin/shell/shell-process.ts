import { spawn } from "node:child_process";

import { SHELL_KILL_GRACE_MS } from "./shell-limits.js";

/** 命令结束的原因；超时与取消必须与正常退出区分，调用方据此决定下一步。 */
export const SHELL_TERMINATIONS = Object.freeze({
  EXITED: "exited",
  TIMED_OUT: "timed_out",
  ABORTED: "aborted",
} as const);

/** 命令结束原因的字面量联合。 */
export type ShellTermination =
  (typeof SHELL_TERMINATIONS)[keyof typeof SHELL_TERMINATIONS];

/** 一次命令执行的请求参数，均已校验与归一。 */
export interface ShellRunRequest {
  readonly command: string;
  readonly workdir: string;
  readonly timeoutMs: number;
  readonly maxOutputBytes: number;
}

/** 一次命令执行的结果；输出按流分离并各自标记是否截断。 */
export interface ShellRunResult {
  readonly termination: ShellTermination;
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly stdoutTruncated: boolean;
  readonly stderrTruncated: boolean;
}

/** 按上限累积字节流；超过上限后只置截断标记，不再增长内存。 */
class OutputCollector {
  readonly #chunks: Buffer[] = [];
  readonly #maxBytes: number;
  #bytes = 0;
  #truncated = false;

  public constructor(maxBytes: number) {
    this.#maxBytes = maxBytes;
  }

  public push(chunk: Buffer): void {
    if (this.#bytes >= this.#maxBytes) {
      this.#truncated = true;
      return;
    }
    const remaining = this.#maxBytes - this.#bytes;
    if (chunk.byteLength <= remaining) {
      this.#chunks.push(chunk);
      this.#bytes += chunk.byteLength;
      return;
    }
    this.#chunks.push(chunk.subarray(0, remaining));
    this.#bytes = this.#maxBytes;
    this.#truncated = true;
  }

  public text(): string {
    return Buffer.concat(this.#chunks).toString("utf8");
  }

  public get truncated(): boolean {
    return this.#truncated;
  }
}

/**
 * 对**整个进程组**发信号。
 *
 * 只终止直接子进程是不够的：`npm test`、`make`、shell 脚本都会派生孙进程，杀掉父进程后它们会被
 * 过继给 init 并继续占用 CPU 与端口。因此子进程以 `detached` 启动成为进程组组长，这里对 `-pid`
 * 发信号，一次覆盖全组。
 *
 * 先 SIGTERM 给命令清理机会（删除临时文件、关闭连接），宽限期后升级为 SIGKILL——忽略 SIGTERM 的
 * 命令必须能被强制终止，否则超时会退化成永久挂起。
 */
function terminateGroup(pid: number, graceMilliseconds: number): void {
  signalGroup(pid, "SIGTERM");
  const escalation = setTimeout((): void => {
    signalGroup(pid, "SIGKILL");
  }, graceMilliseconds);
  // 宽限定时器不得阻止宿主进程退出：它在正常路径下没有其他作用。
  escalation.unref();
}

function signalGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch {
    // 进程组已经不存在，说明命令先一步退出；这不是错误。
  }
}

/**
 * 执行一条 shell 命令，返回分离的输出与结束原因。
 *
 * 收尾监听的是 `close` 而不是 `exit`：`exit` 只表示进程结束了，
 * 而 stdout/stderr 的管道里可能还有没读完的缓冲数据。用 `exit` 会稳定丢掉输出的尾巴——
 * 命令报错时最后的错误信息恰恰就在那里。
 *
 * `termination` 的三个取值由超时与取消分别设置，`close` 时原样带出：
 * 调用方需要区分「命令自己退出（哪怕是非零）」与「被我们杀掉的」，
 * 后者不该被报成命令的失败。
 *
 * @param request - 已校验的执行条件：命令、工作目录、超时与输出上限
 * @param signal - 取消信号，中止时终止整个进程组
 * @returns 分离的 stdout/stderr、结束原因与截断标记
 */
export function runShellCommand(
  request: ShellRunRequest,
  signal: AbortSignal,
): Promise<ShellRunResult> {
  return new Promise<ShellRunResult>((resolve, reject): void =>
    spawnAndCollect(resolve, reject, request, signal),
  );
}

/**
 * 启动命令并收集输出与结束原因。
 *
 * `settled` 保证只结算一次：`error` 与 `close` 都可能到达。
 * `termination` 由超时与取消分别设置、`close` 时原样带出，
 * 调用方据此区分「命令自己退出（哪怕非零）」与「被我们杀掉的」。
 */
function spawnAndCollect(
  resolve: (result: ShellRunResult) => void,
  reject: (error: Error) => void,
  request: ShellRunRequest,
  signal: AbortSignal,
): void {
  const child = spawn("bash", ["-c", request.command], {
    cwd: request.workdir,
    detached: true,
    // stdin 关闭：需要交互输入的命令必须直接失败，而不是挂住整个运行。
    stdio: ["ignore", "pipe", "pipe"],
  });

  const stdout = new OutputCollector(request.maxOutputBytes);
  const stderr = new OutputCollector(request.maxOutputBytes);
  let termination: ShellTermination = SHELL_TERMINATIONS.EXITED;
  let settled = false;

  /** 超时：记录结束原因并终止整个进程组。 */
  function onTimeout(): void {
    termination = SHELL_TERMINATIONS.TIMED_OUT;
    if (child.pid !== undefined) terminateGroup(child.pid, SHELL_KILL_GRACE_MS);
  }

  const timeout = setTimeout(onTimeout, request.timeoutMs);

  /** 取消：记录结束原因并终止整个进程组。 */
  function onAbort(): void {
    termination = SHELL_TERMINATIONS.ABORTED;
    if (child.pid !== undefined) terminateGroup(child.pid, SHELL_KILL_GRACE_MS);
  }

  /** 摘掉定时器与取消监听；结算后必调，避免宽限期定时器把进程钉在事件循环里。 */
  function cleanup(): void {
    clearTimeout(timeout);
    signal.removeEventListener("abort", onAbort);
  }

  /** 只结算一次；返回 true 表示这次调用完成了结算。 */
  function settleOnce(): boolean {
    if (settled) return false;
    settled = true;
    cleanup();
    return true;
  }

  function onSpawnError(cause: Error): void {
    if (!settleOnce()) return;
    reject(new Error(`启动命令失败: ${cause.message}`, { cause }));
  }

  function onClose(
    code: number | null,
    closeSignal: NodeJS.Signals | null,
  ): void {
    if (!settleOnce()) return;
    resolve({
      termination,
      exitCode: code,
      signal: closeSignal,
      stdout: stdout.text(),
      stderr: stderr.text(),
      stdoutTruncated: stdout.truncated,
      stderrTruncated: stderr.truncated,
    });
  }

  if (signal.aborted) onAbort();
  else signal.addEventListener("abort", onAbort, { once: true });

  if (child.stdout !== null) {
    child.stdout.on("data", (chunk: Buffer): void => stdout.push(chunk));
  }
  if (child.stderr !== null) {
    child.stderr.on("data", (chunk: Buffer): void => stderr.push(chunk));
  }

  child.on("error", onSpawnError);
  child.on("close", onClose);
}
