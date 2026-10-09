import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it, type TestContext } from "node:test";

import type { ToolCallContext } from "../../../../src/pipeline/context/runtime-context.js";
import { MemoryFileReadLedger } from "../../../../src/tool/builtin/file-access/read-ledger.js";
import type { FileReadLedger } from "../../../../src/tool/builtin/file-access/port/file-read-ledger.js";
import { UnrestrictedReadTool } from "../../../../src/tool/builtin/read-file/read-file-tool.js";
import { ApplyPatchTool } from "../../../../src/tool/builtin/apply-patch/apply-patch-tool.js";

function contextFor(threadId: string): ToolCallContext {
  return {
    threadId,
    userId: "user-a",
    requestId: "",
    traceId: "",
    callId: "",
    checkpointRevision: 0n,
    fencingToken: 0n,
  };
}

async function temporaryDirectory(test: TestContext): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "runtime-patch-test-"));
  test.after(async (): Promise<void> => {
    await rm(directory, { recursive: true, force: true });
  });
  return directory;
}

async function prepared(
  test: TestContext,
  initial: string,
): Promise<{ target: string; tool: ApplyPatchTool }> {
  const directory = await temporaryDirectory(test);
  const target = path.join(directory, "subject.txt");
  await writeFile(target, initial, "utf8");
  const ledger: FileReadLedger = new MemoryFileReadLedger();
  await new UnrestrictedReadTool(ledger).execute(
    { file_path: target },
    contextFor("thread-a"),
    AbortSignal.timeout(5_000),
  );
  return { target, tool: new ApplyPatchTool({ ledger }) };
}

void describe("Runtime TypeScript apply-patch tool", () => {
  void it("applies several edits with a single write", async (test) => {
    const { target, tool } = await prepared(test, "alpha\nbeta\ngamma\n");

    const result = await tool.execute(
      {
        file_path: target,
        edits: [
          { old_string: "alpha", new_string: "ALPHA" },
          { old_string: "gamma", new_string: "GAMMA" },
        ],
      },
      contextFor("thread-a"),
      AbortSignal.timeout(5_000),
    );

    assert.equal(await readFile(target, "utf8"), "ALPHA\nbeta\nGAMMA\n");
    assert.match(result.content, /2/);
  });

  void it("applies edits in order so a later edit can target earlier output", async (test) => {
    const { target, tool } = await prepared(test, "start\n");

    await tool.execute(
      {
        file_path: target,
        edits: [
          { old_string: "start", new_string: "middle" },
          { old_string: "middle", new_string: "end" },
        ],
      },
      contextFor("thread-a"),
      AbortSignal.timeout(5_000),
    );

    assert.equal(await readFile(target, "utf8"), "end\n");
  });

  void it("writes nothing when any edit does not match exactly once", async (test) => {
    const { target, tool } = await prepared(test, "alpha\nbeta\nsame\nsame\n");

    // 第一处能匹配，第二处匹配不到：必须整体失败，不能留下半套改动
    await assert.rejects(
      tool.execute(
        {
          file_path: target,
          edits: [
            { old_string: "alpha", new_string: "ALPHA" },
            { old_string: "missing", new_string: "x" },
          ],
        },
        contextFor("thread-a"),
        AbortSignal.timeout(5_000),
      ),
      /未找到/,
    );
    assert.equal(await readFile(target, "utf8"), "alpha\nbeta\nsame\nsame\n");

    // 匹配不唯一同样必须整体失败
    await assert.rejects(
      tool.execute(
        {
          file_path: target,
          edits: [{ old_string: "same", new_string: "x" }],
        },
        contextFor("thread-a"),
        AbortSignal.timeout(5_000),
      ),
      /出现 2 处/,
    );
    assert.equal(await readFile(target, "utf8"), "alpha\nbeta\nsame\nsame\n");
  });

  void it("requires a prior read and rejects invalid input", async (test) => {
    const directory = await temporaryDirectory(test);
    const target = path.join(directory, "unread.txt");
    await writeFile(target, "alpha\n", "utf8");
    const tool = new ApplyPatchTool({ ledger: new MemoryFileReadLedger() });

    await assert.rejects(
      tool.execute(
        {
          file_path: target,
          edits: [{ old_string: "alpha", new_string: "beta" }],
        },
        contextFor("thread-a"),
        AbortSignal.timeout(5_000),
      ),
      /先读|未读/,
    );
    await assert.rejects(
      tool.execute(
        { file_path: target, edits: [] },
        contextFor("thread-a"),
        AbortSignal.timeout(5_000),
      ),
      /edits/,
    );
    await assert.rejects(
      tool.execute(
        { file_path: target, edits: [{ old_string: "a" }] },
        contextFor("thread-a"),
        AbortSignal.timeout(5_000),
      ),
      /new_string/,
    );
    assert.equal(await readFile(target, "utf8"), "alpha\n");
  });
});
