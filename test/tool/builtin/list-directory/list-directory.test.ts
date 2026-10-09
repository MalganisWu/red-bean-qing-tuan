import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it, type TestContext } from "node:test";

import type { ToolCallContext } from "../../../../src/pipeline/context/runtime-context.js";
import { ListDirectoryTool } from "../../../../src/tool/builtin/list-directory/list-directory-tool.js";

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
  const directory = await mkdtemp(path.join(tmpdir(), "runtime-list-test-"));
  test.after(async (): Promise<void> => {
    await rm(directory, { recursive: true, force: true });
  });
  return directory;
}

function execute(
  tool: ListDirectoryTool,
  params: Record<string, string>,
): Promise<Awaited<ReturnType<ListDirectoryTool["execute"]>>> {
  return tool.execute(params, context, AbortSignal.timeout(5_000));
}

void describe("Runtime TypeScript list-directory tool", () => {
  void it("lists sorted entries and marks directories", async (test) => {
    const directory = await temporaryDirectory(test);
    await writeFile(path.join(directory, "beta.txt"), "b", "utf8");
    await writeFile(path.join(directory, "alpha.txt"), "a", "utf8");
    await mkdir(path.join(directory, "gamma"));
    await mkdir(path.join(directory, "delta"));

    const result = await execute(new ListDirectoryTool(), { path: directory });

    const lines = result.content.split("\n");
    assert.deepEqual(lines, ["alpha.txt", "beta.txt", "delta/", "gamma/"]);
  });

  void it("reports truncation with the full entry count", async (test) => {
    const directory = await temporaryDirectory(test);
    await writeFile(path.join(directory, "a.txt"), "a", "utf8");
    await writeFile(path.join(directory, "b.txt"), "b", "utf8");
    await writeFile(path.join(directory, "c.txt"), "c", "utf8");

    const result = await execute(new ListDirectoryTool({ maxEntries: 2 }), {
      path: directory,
    });

    const lines = result.content.split("\n");
    assert.deepEqual(lines.slice(0, 2), ["a.txt", "b.txt"]);
    // 被截断时必须告知总量与缩小范围的方式，否则调用方会误以为目录只有这么多内容
    assert.match(lines.slice(2).join("\n"), /3/);
    assert.match(lines.slice(2).join("\n"), /截断/);
  });

  void it("rejects a non-directory path and invalid input", async (test) => {
    const directory = await temporaryDirectory(test);
    const file = path.join(directory, "a.txt");
    await writeFile(file, "a", "utf8");

    await assert.rejects(
      execute(new ListDirectoryTool(), { path: file }),
      /目录/,
    );
    await assert.rejects(
      execute(new ListDirectoryTool(), {
        path: path.join(directory, "missing"),
      }),
    );
    await assert.rejects(
      execute(new ListDirectoryTool(), { path: "" }),
      /path/,
    );
  });

  void it("marks an empty directory instead of returning an empty string", async (test) => {
    const directory = await temporaryDirectory(test);
    const result = await execute(new ListDirectoryTool(), { path: directory });
    assert.notEqual(result.content.trim(), "");
  });
});
