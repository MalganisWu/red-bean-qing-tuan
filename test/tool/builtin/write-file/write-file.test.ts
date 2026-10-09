import assert from "node:assert/strict";
import {
  mkdtemp,
  readdir,
  readFile,
  rm,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it, type TestContext } from "node:test";

import type { ToolCallContext } from "../../../../src/pipeline/context/runtime-context.js";
import { MemoryFileReadLedger } from "../../../../src/tool/builtin/file-access/read-ledger.js";
import type { FileReadLedger } from "../../../../src/tool/builtin/file-access/port/file-read-ledger.js";
import { UnrestrictedReadTool } from "../../../../src/tool/builtin/read-file/read-file-tool.js";
import { WriteFileTool } from "../../../../src/tool/builtin/write-file/write-file-tool.js";

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
  const directory = await mkdtemp(path.join(tmpdir(), "runtime-write-test-"));
  test.after(async (): Promise<void> => {
    await rm(directory, { recursive: true, force: true });
  });
  return directory;
}

/** 先用读取工具建立账本记录，模拟模型「先读后写」的正常顺序。 */
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

void describe("Runtime TypeScript write-file tool", () => {
  void it("creates a new file with parent directories and reports the result", async (test) => {
    const directory = await temporaryDirectory(test);
    const target = path.join(directory, "nested", "deep", "new.txt");
    const tool = new WriteFileTool({ ledger: new MemoryFileReadLedger() });

    // 新建没有内容可以覆盖，因此不要求先读
    const result = await tool.execute(
      { file_path: target, content: "alpha\nbeta\n" },
      contextFor("thread-a"),
      AbortSignal.timeout(5_000),
    );

    assert.equal(await readFile(target, "utf8"), "alpha\nbeta\n");
    assert.match(result.content, /2/);
  });

  void it("overwrites an existing file only after the same conversation read it", async (test) => {
    const directory = await temporaryDirectory(test);
    const target = path.join(directory, "existing.txt");
    await writeFile(target, "old\n", "utf8");
    const ledger = new MemoryFileReadLedger();
    const tool = new WriteFileTool({ ledger });

    await assert.rejects(
      tool.execute(
        { file_path: target, content: "new\n" },
        contextFor("thread-a"),
        AbortSignal.timeout(5_000),
      ),
      /先读|未读/,
    );
    assert.equal(await readFile(target, "utf8"), "old\n");

    await readFirst(ledger, target);
    await tool.execute(
      { file_path: target, content: "new\n" },
      contextFor("thread-a"),
      AbortSignal.timeout(5_000),
    );
    assert.equal(await readFile(target, "utf8"), "new\n");
  });

  void it("refuses to overwrite when the file changed after the read", async (test) => {
    const directory = await temporaryDirectory(test);
    const target = path.join(directory, "moving.txt");
    await writeFile(target, "v1\n", "utf8");
    const ledger = new MemoryFileReadLedger();
    await readFirst(ledger, target);

    // 读完之后文件被外部改动：模型手里的版本已经过期，覆盖会静默丢弃别人的修改
    await writeFile(target, "v2\n", "utf8");
    await utimes(target, new Date(2_000, 0, 1), new Date(2_000, 0, 1));

    await assert.rejects(
      new WriteFileTool({ ledger }).execute(
        { file_path: target, content: "v3\n" },
        contextFor("thread-a"),
        AbortSignal.timeout(5_000),
      ),
      /变化|版本/,
    );
    assert.equal(await readFile(target, "utf8"), "v2\n");
  });

  void it("does not accept another conversation's read as authorization", async (test) => {
    const directory = await temporaryDirectory(test);
    const target = path.join(directory, "shared.txt");
    await writeFile(target, "old\n", "utf8");
    const ledger = new MemoryFileReadLedger();
    const tool = new WriteFileTool({ ledger });
    await readFirst(ledger, target, "thread-a");

    await assert.rejects(
      tool.execute(
        { file_path: target, content: "new\n" },
        contextFor("thread-b"),
        AbortSignal.timeout(5_000),
      ),
      /先读|未读/,
    );
    assert.equal(await readFile(target, "utf8"), "old\n");
  });

  void it("leaves the original intact and rejects invalid input", async (test) => {
    const directory = await temporaryDirectory(test);
    const target = path.join(directory, "keep.txt");
    await writeFile(target, "keep\n", "utf8");
    const ledger = new MemoryFileReadLedger();
    await readFirst(ledger, target);
    const tool = new WriteFileTool({ ledger });

    await assert.rejects(
      tool.execute(
        { file_path: target, content: "x" },
        contextFor("thread-c"),
        AbortSignal.timeout(5_000),
      ),
    );
    assert.equal(await readFile(target, "utf8"), "keep\n");

    await assert.rejects(
      tool.execute(
        { file_path: "", content: "x" },
        contextFor("thread-a"),
        AbortSignal.timeout(5_000),
      ),
      /file_path/,
    );
    await assert.rejects(
      tool.execute(
        { file_path: target },
        contextFor("thread-a"),
        AbortSignal.timeout(5_000),
      ),
      /content/,
    );

    // 失败写入不得留下临时文件
    assert.deepEqual(await readdir(directory), ["keep.txt"]);
  });
});
