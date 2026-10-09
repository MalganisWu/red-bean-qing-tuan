import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it, type TestContext } from "node:test";

import type { ToolCallContext } from "../../../../src/pipeline/context/runtime-context.js";
import { MemoryFileReadLedger } from "../../../../src/tool/builtin/file-access/read-ledger.js";
import type { FileReadLedger } from "../../../../src/tool/builtin/file-access/port/file-read-ledger.js";
import { UnrestrictedReadTool } from "../../../../src/tool/builtin/read-file/read-file-tool.js";
import { EditFileTool } from "../../../../src/tool/builtin/edit-file/edit-file-tool.js";

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
  const directory = await mkdtemp(path.join(tmpdir(), "runtime-edit-test-"));
  test.after(async (): Promise<void> => {
    await rm(directory, { recursive: true, force: true });
  });
  return directory;
}

async function readFirst(
  ledger: FileReadLedger,
  filePath: string,
  threadId = "thread-a",
): Promise<void> {
  await new UnrestrictedReadTool(ledger).execute(
    { file_path: filePath },
    contextFor(threadId),
    AbortSignal.timeout(5_000),
  );
}

/** 建立「已读 + 工具就绪」的常规前置状态。 */
async function prepared(
  test: TestContext,
  initial: string,
): Promise<{ target: string; tool: EditFileTool }> {
  const directory = await temporaryDirectory(test);
  const target = path.join(directory, "subject.txt");
  await writeFile(target, initial, "utf8");
  const ledger = new MemoryFileReadLedger();
  await readFirst(ledger, target);
  return { target, tool: new EditFileTool({ ledger }) };
}

void describe("Runtime TypeScript edit-file tool", () => {
  void it("replaces a unique occurrence and reports the count", async (test) => {
    const { target, tool } = await prepared(test, "alpha\nbeta\ngamma\n");

    const result = await tool.execute(
      { file_path: target, old_string: "beta", new_string: "BETA" },
      contextFor("thread-a"),
      AbortSignal.timeout(5_000),
    );

    assert.equal(await readFile(target, "utf8"), "alpha\nBETA\ngamma\n");
    assert.match(result.content, /1/);
  });

  void it("refuses an absent or non-unique match instead of guessing", async (test) => {
    const { target, tool } = await prepared(test, "same\nsame\ndiff\n");

    await assert.rejects(
      tool.execute(
        { file_path: target, old_string: "missing", new_string: "x" },
        contextFor("thread-a"),
        AbortSignal.timeout(5_000),
      ),
      /未找到/,
    );
    // 多处匹配时无法判断模型想改哪一个，必须报出确切处数并要求更多上下文，而不是擅自全改
    await assert.rejects(
      tool.execute(
        { file_path: target, old_string: "same", new_string: "x" },
        contextFor("thread-a"),
        AbortSignal.timeout(5_000),
      ),
      (error: unknown): boolean => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /出现 2 处/);
        assert.match(error.message, /replace_all/);
        return true;
      },
    );
    assert.equal(await readFile(target, "utf8"), "same\nsame\ndiff\n");
  });

  void it("replaces every occurrence only when replace_all is set", async (test) => {
    const { target, tool } = await prepared(test, "same\nsame\ndiff\n");

    const result = await tool.execute(
      {
        file_path: target,
        old_string: "same",
        new_string: "other",
        replace_all: true,
      },
      contextFor("thread-a"),
      AbortSignal.timeout(5_000),
    );

    assert.equal(await readFile(target, "utf8"), "other\nother\ndiff\n");
    assert.match(result.content, /2/);
  });

  void it("requires a prior read in the same conversation", async (test) => {
    const directory = await temporaryDirectory(test);
    const target = path.join(directory, "unread.txt");
    await writeFile(target, "alpha\n", "utf8");
    const tool = new EditFileTool({ ledger: new MemoryFileReadLedger() });

    await assert.rejects(
      tool.execute(
        { file_path: target, old_string: "alpha", new_string: "beta" },
        contextFor("thread-a"),
        AbortSignal.timeout(5_000),
      ),
      /先读|未读/,
    );
    assert.equal(await readFile(target, "utf8"), "alpha\n");
  });

  void it("refuses to edit when the file changed after the read", async (test) => {
    const { target, tool } = await prepared(test, "alpha\n");
    await writeFile(target, "external\n", "utf8");
    await utimes(target, new Date(2_000, 0, 1), new Date(2_000, 0, 1));

    await assert.rejects(
      tool.execute(
        { file_path: target, old_string: "external", new_string: "mine" },
        contextFor("thread-a"),
        AbortSignal.timeout(5_000),
      ),
      /变化|版本/,
    );
    assert.equal(await readFile(target, "utf8"), "external\n");
  });

  void it("rejects invalid and no-op edits", async (test) => {
    const { target, tool } = await prepared(test, "alpha\n");

    await assert.rejects(
      tool.execute(
        { file_path: target, old_string: "", new_string: "x" },
        contextFor("thread-a"),
        AbortSignal.timeout(5_000),
      ),
      /old_string/,
    );
    await assert.rejects(
      tool.execute(
        { file_path: target, old_string: "alpha" },
        contextFor("thread-a"),
        AbortSignal.timeout(5_000),
      ),
      /new_string/,
    );
    // 替换成同样内容是无意义写入，拒绝可以避免无谓地推进文件版本
    await assert.rejects(
      tool.execute(
        { file_path: target, old_string: "alpha", new_string: "alpha" },
        contextFor("thread-a"),
        AbortSignal.timeout(5_000),
      ),
      /相同/,
    );
    assert.equal(await readFile(target, "utf8"), "alpha\n");
  });
});
