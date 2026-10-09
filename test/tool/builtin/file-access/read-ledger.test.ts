import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it, type TestContext } from "node:test";

import type { ToolCallContext } from "../../../../src/pipeline/context/runtime-context.js";
import { MemoryFileReadLedger } from "../../../../src/tool/builtin/file-access/read-ledger.js";
import type { FileReadLedger } from "../../../../src/tool/builtin/file-access/port/file-read-ledger.js";
import {
  FILE_UNCHANGED_STUB,
  UnrestrictedReadTool,
} from "../../../../src/tool/builtin/read-file/read-file-tool.js";

const context: ToolCallContext = {
  threadId: "thread-a",
  userId: "user-a",
  requestId: "",
  traceId: "",
  callId: "",
  checkpointRevision: 0n,
  fencingToken: 0n,
};

const record = {
  mtimeMs: 1_700_000_000_000,
  offset: 1,
  limit: 100,
  identity: { device: 1, inode: 2 },
};

async function temporaryDirectory(test: TestContext): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "runtime-ledger-test-"));
  test.after(async (): Promise<void> => {
    await rm(directory, { recursive: true, force: true });
  });
  return directory;
}

void describe("Runtime TypeScript file read ledger", () => {
  void it("isolates records by conversation and overwrites per file", () => {
    const ledger = new MemoryFileReadLedger();

    assert.equal(ledger.read("thread-a", "/tmp/x"), undefined);
    ledger.record("thread-a", "/tmp/x", record);
    assert.deepEqual(ledger.read("thread-a", "/tmp/x"), record);

    // 另一个 conversation 没有读过该文件，不得看到 thread-a 的记录
    assert.equal(ledger.read("thread-b", "/tmp/x"), undefined);

    // 同一 conversation 的同一文件只能保留最近一次读取
    const newer = { ...record, mtimeMs: record.mtimeMs + 1 };
    ledger.record("thread-a", "/tmp/x", newer);
    assert.deepEqual(ledger.read("thread-a", "/tmp/x"), newer);

    ledger.forget("thread-a", "/tmp/x");
    assert.equal(ledger.read("thread-a", "/tmp/x"), undefined);
    // forget 只作用于指定 conversation
    ledger.record("thread-b", "/tmp/x", record);
    ledger.forget("thread-a", "/tmp/x");
    assert.deepEqual(ledger.read("thread-b", "/tmp/x"), record);
  });

  void it("keeps path keys unambiguous regardless of thread id content", () => {
    const ledger = new MemoryFileReadLedger();
    // 拼接歧义会在这里撞车：("a", "b\0c") 与 ("a\0b", "c") 必须互不可见
    ledger.record("a", "b\u0000c", record);
    assert.equal(ledger.read("a\u0000b", "c"), undefined);
    assert.deepEqual(ledger.read("a", "b\u0000c"), record);
  });

  void it("shares read state across tool instances through one ledger", async (test) => {
    const directory = await temporaryDirectory(test);
    const file = path.join(directory, "shared.txt");
    await writeFile(file, "hello\nworld\n", "utf8");

    // 读取工具与写入工具是不同实例；宿主共享账本时，读取记录才能被写入类工具看见
    const shared: FileReadLedger = new MemoryFileReadLedger();
    const reader = new UnrestrictedReadTool(shared);
    const observer = new UnrestrictedReadTool(shared);

    const first = await reader.execute(
      { file_path: file },
      context,
      AbortSignal.timeout(2_000),
    );
    assert.notEqual(first.content, FILE_UNCHANGED_STUB);

    const observed = await observer.execute(
      { file_path: file },
      context,
      AbortSignal.timeout(2_000),
    );
    assert.equal(observed.content, FILE_UNCHANGED_STUB);

    // 各自持有账本时互不可见，这正是「先读后写」必须显式共享账本的原因
    const isolated = new UnrestrictedReadTool(new MemoryFileReadLedger());
    const independent = await isolated.execute(
      { file_path: file },
      context,
      AbortSignal.timeout(2_000),
    );
    assert.notEqual(independent.content, FILE_UNCHANGED_STUB);
  });
});
