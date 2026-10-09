import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it, type TestContext } from "node:test";

import type { ToolCallContext } from "../../../../src/pipeline/context/runtime-context.js";
import { ShellTool } from "../../../../src/tool/builtin/shell/shell-tool.js";

const context: ToolCallContext = {
  threadId: "thread-a",
  userId: "user-a",
  requestId: "",
  traceId: "",
  callId: "",
  checkpointRevision: 0n,
  fencingToken: 0n,
};

async function temporaryDirectory(test: TestContext): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "runtime-shell-test-"));
  test.after(async (): Promise<void> => {
    await rm(directory, { recursive: true, force: true });
  });
  return directory;
}

function execute(
  tool: ShellTool,
  params: Record<string, string | number>,
  signal: AbortSignal = AbortSignal.timeout(15_000),
): Promise<Awaited<ReturnType<ShellTool["execute"]>>> {
  return tool.execute(params, context, signal);
}

/** 进程仍存在时返回 true；用于确认被杀的是整个进程组而不只是直接子进程。 */
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

void describe("Runtime TypeScript shell tool", () => {
  void it("returns stdout and a zero exit code", async (test) => {
    const directory = await temporaryDirectory(test);
    const result = await execute(new ShellTool(), {
      command: "printf 'hello\\n'",
      description: "Print a greeting",
      workdir: directory,
    });

    assert.match(result.content, /hello/);
    assert.match(result.content, /\[exit code: 0\]/);
  });

  void it("reports a non-zero exit code and keeps stderr separate", async (test) => {
    const directory = await temporaryDirectory(test);
    const result = await execute(new ShellTool(), {
      command: "printf 'out\\n'; printf 'boom\\n' >&2; exit 3",
      description: "Fail with a message",
      workdir: directory,
    });

    assert.match(result.content, /\[exit code: 3\]/);
    assert.match(result.content, /boom/);
    // stdout 与 stderr 必须可区分，否则模型无法判断哪部分是错误信息
    assert.match(result.content, /stderr/);
  });

  void it("runs in the requested working directory", async (test) => {
    const directory = await temporaryDirectory(test);
    await writeFile(path.join(directory, "marker.txt"), "x", "utf8");

    const result = await execute(new ShellTool(), {
      command: "cat marker.txt",
      description: "Read marker in workdir",
      workdir: directory,
    });

    assert.match(result.content, /x/);
    assert.match(result.content, /\[exit code: 0\]/);
  });

  void it("kills the whole process group on timeout", async (test) => {
    const directory = await temporaryDirectory(test);
    const pidFile = path.join(directory, "child.pid");
    const tool = new ShellTool({ defaultTimeoutMs: 800 });

    const startedAt = Date.now();
    const result = await execute(tool, {
      command: `sleep 30 & echo $! > ${pidFile}; wait`,
      description: "Spawn a long child then wait",
      workdir: directory,
    });
    const elapsed = Date.now() - startedAt;

    assert.match(result.content, /timed out/i);
    // 只杀直接子进程会让这里等满 30 秒；必须在超时后很快返回
    assert.ok(elapsed < 8_000, `超时未及时返回，耗时 ${elapsed}ms`);

    // 派生进程也必须被终止，否则会持续占用资源
    const childPid = Number((await readFile(pidFile, "utf8")).trim());
    assert.ok(Number.isInteger(childPid) && childPid > 0);
    assert.equal(isAlive(childPid), false, `派生进程 ${childPid} 仍存活`);
  });

  void it("kills the process group when the caller aborts", async (test) => {
    const directory = await temporaryDirectory(test);
    const pidFile = path.join(directory, "abort.pid");
    const controller = new AbortController();
    const promise = execute(
      new ShellTool(),
      {
        command: `sleep 30 & echo $! > ${pidFile}; wait`,
        description: "Spawn a child then wait for abort",
        workdir: directory,
      },
      controller.signal,
    );
    setTimeout((): void => controller.abort(), 500);

    const result = await promise;
    assert.match(result.content, /abort/i);

    const childPid = Number((await readFile(pidFile, "utf8")).trim());
    assert.ok(Number.isInteger(childPid) && childPid > 0);
    assert.equal(isAlive(childPid), false, `派生进程 ${childPid} 仍存活`);
  });

  void it("truncates oversized output and says so", async (test) => {
    const directory = await temporaryDirectory(test);
    const tool = new ShellTool({ maxOutputBytes: 512 });

    const result = await execute(tool, {
      command: "for i in $(seq 1 400); do echo 'aaaaaaaaaaaaaaaaaaaa'; done",
      description: "Produce a lot of output",
      workdir: directory,
    });

    assert.match(result.content, /truncat|截断/i);
    assert.ok(
      result.content.length < 2_000,
      `输出未被截断：${result.content.length}`,
    );
  });

  void it("rejects missing command or description", async (test) => {
    const directory = await temporaryDirectory(test);
    const tool = new ShellTool();

    await assert.rejects(
      execute(tool, { description: "no command", workdir: directory }),
      /command/,
    );
    // description 必填：它服务于工具调用的可读展示与事后审计，事后无法补造
    await assert.rejects(
      execute(tool, { command: "true", workdir: directory }),
      /description/,
    );
    await assert.rejects(
      execute(tool, { command: "", description: "empty" }),
      /command/,
    );
  });
});
