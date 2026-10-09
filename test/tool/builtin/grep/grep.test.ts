import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it, type TestContext } from "node:test";

import type { ToolCallContext } from "../../../../src/pipeline/context/runtime-context.js";
import { GrepTool } from "../../../../src/tool/builtin/grep/grep-tool.js";

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
  const directory = await mkdtemp(path.join(tmpdir(), "runtime-grep-test-"));
  test.after(async (): Promise<void> => {
    await rm(directory, { recursive: true, force: true });
  });
  return directory;
}

function execute(
  tool: GrepTool,
  params: Record<string, string>,
): Promise<Awaited<ReturnType<GrepTool["execute"]>>> {
  return tool.execute(params, context, AbortSignal.timeout(5_000));
}

void describe("Runtime TypeScript grep tool", () => {
  void it("reports matching lines with path and line number", async (test) => {
    const directory = await temporaryDirectory(test);
    await mkdir(path.join(directory, "src"), { recursive: true });
    await writeFile(
      path.join(directory, "src", "a.ts"),
      "const alpha = 1\nconst beta = 2\n",
      "utf8",
    );
    await writeFile(
      path.join(directory, "b.ts"),
      "// alpha here\nexport {}\n",
      "utf8",
    );

    const result = await execute(new GrepTool(), {
      pattern: "alpha",
      path: directory,
    });

    assert.deepEqual(result.content.split("\n"), [
      "b.ts:1: // alpha here",
      "src/a.ts:1: const alpha = 1",
    ]);
  });

  void it("filters files by include glob and skips binary content", async (test) => {
    const directory = await temporaryDirectory(test);
    await mkdir(path.join(directory, "sub"), { recursive: true });
    await writeFile(path.join(directory, "keep.ts"), "needle\n", "utf8");
    await writeFile(path.join(directory, "skip.md"), "needle\n", "utf8");
    await writeFile(path.join(directory, "sub", "deep.ts"), "needle\n", "utf8");
    // 含 NUL 的文件按二进制处理，匹配它只会把乱码塞进上下文
    await writeFile(
      path.join(directory, "blob.ts"),
      Buffer.from([0x6e, 0x00, 0x65, 0x65, 0x64, 0x6c, 0x65]),
    );

    const result = await execute(new GrepTool(), {
      pattern: "needle",
      path: directory,
      include: "**/*.ts",
    });

    const lines = result.content.split("\n");
    assert.deepEqual(lines.slice(0, 2), [
      "keep.ts:1: needle",
      "sub/deep.ts:1: needle",
    ]);
    // 被跳过的文件必须明确报告：静默丢弃会让调用方以为文件里没有匹配
    assert.match(lines.slice(2).join("\n"), /二进制/);
  });

  void it("reports no matches and truncates with the match count", async (test) => {
    const directory = await temporaryDirectory(test);
    await writeFile(path.join(directory, "a.txt"), "hit\nhit\n", "utf8");
    await writeFile(path.join(directory, "b.txt"), "hit\n", "utf8");

    const none = await execute(new GrepTool(), {
      pattern: "absent",
      path: directory,
    });
    assert.match(none.content, /没有匹配/);

    const capped = await execute(new GrepTool({ maxMatches: 2 }), {
      pattern: "hit",
      path: directory,
    });
    const lines = capped.content.split("\n");
    assert.deepEqual(lines.slice(0, 2), ["a.txt:1: hit", "a.txt:2: hit"]);
    assert.match(lines.slice(2).join("\n"), /截断/);
    assert.match(lines.slice(2).join("\n"), /3/);
  });

  void it("rejects an invalid regex and invalid input", async (test) => {
    const directory = await temporaryDirectory(test);

    await assert.rejects(
      execute(new GrepTool(), { pattern: "([", path: directory }),
      /正则/,
    );
    await assert.rejects(execute(new GrepTool(), { pattern: "" }), /pattern/);
    await assert.rejects(
      execute(new GrepTool(), { pattern: "x", path: "" }),
      /path/,
    );
  });
});
