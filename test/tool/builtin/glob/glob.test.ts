import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it, type TestContext } from "node:test";

import type { ToolCallContext } from "../../../../src/pipeline/context/runtime-context.js";
import { GlobTool } from "../../../../src/tool/builtin/glob/glob-tool.js";

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
  const directory = await mkdtemp(path.join(tmpdir(), "runtime-glob-test-"));
  test.after(async (): Promise<void> => {
    await rm(directory, { recursive: true, force: true });
  });
  return directory;
}

function execute(
  tool: GlobTool,
  params: Record<string, string>,
): Promise<Awaited<ReturnType<GlobTool["execute"]>>> {
  return tool.execute(params, context, AbortSignal.timeout(5_000));
}

void describe("Runtime TypeScript glob tool", () => {
  void it("matches by pattern and returns sorted relative paths", async (test) => {
    const directory = await temporaryDirectory(test);
    await mkdir(path.join(directory, "src", "deep"), { recursive: true });
    await writeFile(path.join(directory, "src", "b.ts"), "", "utf8");
    await writeFile(path.join(directory, "src", "a.ts"), "", "utf8");
    await writeFile(path.join(directory, "src", "deep", "c.ts"), "", "utf8");
    await writeFile(path.join(directory, "src", "d.md"), "", "utf8");

    const result = await execute(new GlobTool(), {
      pattern: "src/**/*.ts",
      path: directory,
    });

    assert.deepEqual(result.content.split("\n"), [
      "src/a.ts",
      "src/b.ts",
      "src/deep/c.ts",
    ]);
  });

  void it("excludes dependency and VCS directories by default", async (test) => {
    const directory = await temporaryDirectory(test);
    await mkdir(path.join(directory, "node_modules", "pkg"), {
      recursive: true,
    });
    await mkdir(path.join(directory, ".git", "objects"), { recursive: true });
    await writeFile(
      path.join(directory, "node_modules", "pkg", "a.ts"),
      "",
      "utf8",
    );
    await writeFile(
      path.join(directory, ".git", "objects", "b.ts"),
      "",
      "utf8",
    );
    await writeFile(path.join(directory, "app.ts"), "", "utf8");

    const result = await execute(new GlobTool(), {
      pattern: "**/*.ts",
      path: directory,
    });

    // 依赖与版本库目录是噪音来源，默认排除；否则真实仓里 **/*.ts 会被依赖树淹没
    assert.deepEqual(result.content.split("\n"), ["app.ts"]);
  });

  void it("separates no matches from truncation", async (test) => {
    const directory = await temporaryDirectory(test);
    await writeFile(path.join(directory, "a.ts"), "", "utf8");
    await writeFile(path.join(directory, "b.ts"), "", "utf8");
    await writeFile(path.join(directory, "c.ts"), "", "utf8");

    const none = await execute(new GlobTool(), {
      pattern: "**/*.md",
      path: directory,
    });
    assert.match(none.content, /没有匹配/);

    const capped = await execute(new GlobTool({ maxResults: 2 }), {
      pattern: "**/*.ts",
      path: directory,
    });
    const lines = capped.content.split("\n");
    assert.deepEqual(lines.slice(0, 2), ["a.ts", "b.ts"]);
    assert.match(lines.slice(2).join("\n"), /截断/);
    assert.match(lines.slice(2).join("\n"), /3/);
  });

  void it("rejects invalid input instead of guessing a pattern", async () => {
    await assert.rejects(execute(new GlobTool(), { pattern: "" }), /pattern/);
    await assert.rejects(
      execute(new GlobTool(), { pattern: "**/*", path: "" }),
      /path/,
    );
  });
});
