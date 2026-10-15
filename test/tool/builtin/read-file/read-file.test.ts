import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it, type TestContext } from "node:test";

import type { ToolCallContext } from "../../../../src/pipeline/context/runtime-context.js";
import {
  createRootedReadTool,
  FILE_UNCHANGED_STUB,
  MAX_READ_SIZE_BYTES,
  UnrestrictedReadTool,
} from "../../../../src/tool/builtin/read-file/read-file-tool.js";

const context: ToolCallContext = {
  threadId: "",
  userId: "",
  requestId: "",
  traceId: "",
  callId: "",
  checkpointRevision: 0n,
  fencingToken: 0n,
};

async function temporaryDirectory(test: TestContext): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "runtime-read-test-"));
  test.after(async (): Promise<void> => {
    await rm(directory, { recursive: true, force: true });
  });
  return directory;
}

async function execute(
  tool: UnrestrictedReadTool,
  params: Record<string, string | number>,
): Promise<Awaited<ReturnType<UnrestrictedReadTool["execute"]>>> {
  return tool.execute(params, context, AbortSignal.timeout(2_000));
}

/** 以指定会话身份执行读取，用于验证去重缓存是否按 conversation 隔离。 */
async function executeInThread(
  tool: UnrestrictedReadTool,
  threadId: string,
  params: Record<string, string | number>,
): Promise<Awaited<ReturnType<UnrestrictedReadTool["execute"]>>> {
  return tool.execute(
    params,
    { ...context, threadId },
    AbortSignal.timeout(2_000),
  );
}

void describe("Runtime TypeScript read-file tool", () => {
  void it("reads numbered ranges, reports continuation, and rejects invalid inputs", async (test) => {
    const directory = await temporaryDirectory(test);
    const file = path.join(directory, "sample.txt");
    await writeFile(file, "line1\nline2\nline3\nline4\n", "utf8");
    const tool = new UnrestrictedReadTool();

    const full = await execute(tool, { file_path: file });
    assert.match(full.content, /1\tline1/);
    assert.match(full.content, /4\tline4/);
    assert.doesNotMatch(full.content, /后续用 Read/);

    const ranged = await execute(tool, {
      file_path: file,
      offset: 2,
      limit: 2,
    });
    assert.match(ranged.content, /2\tline2/);
    assert.match(ranged.content, /3\tline3/);
    assert.doesNotMatch(ranged.content, /line4/);
    assert.match(ranged.content, /后续用 Read/);

    await assert.rejects(execute(tool, { file_path: "" }), /file_path/);
    await assert.rejects(
      tool.execute("bad", context, AbortSignal.timeout(1_000)),
      /必须是对象/,
    );
    await assert.rejects(
      execute(tool, { file_path: path.join(directory, "missing.txt") }),
    );
  });

  void it("deduplicates unchanged ranges and preserves a re-readable reference", async (test) => {
    const directory = await temporaryDirectory(test);
    const file = path.join(directory, "sample.txt");
    await writeFile(file, "hello\nworld\n", "utf8");
    const tool = new UnrestrictedReadTool();

    const first = await execute(tool, { file_path: file });
    assert.notEqual(first.content, FILE_UNCHANGED_STUB);
    assert.equal(first.preserve?.kind, "file");
    assert.equal(first.preserve?.key, file);
    assert.equal(typeof first.preserve?.timestamp, "number");

    const duplicate = await execute(tool, { file_path: file });
    assert.equal(duplicate.content, FILE_UNCHANGED_STUB);

    const otherRange = await execute(tool, {
      file_path: file,
      offset: 1,
      limit: 1,
    });
    assert.notEqual(otherRange.content, FILE_UNCHANGED_STUB);

    const restored = await first.preserve?.fetch?.(AbortSignal.timeout(1_000));
    assert.ok(restored);
    assert.match(new TextDecoder().decode(restored), /1\thello/);
    const afterRestore = await execute(tool, { file_path: file });
    assert.notEqual(afterRestore.content, FILE_UNCHANGED_STUB);
  });

  void it("scopes the unchanged-range shortcut to the calling conversation", async (test) => {
    const directory = await temporaryDirectory(test);
    const file = path.join(directory, "shared.txt");
    await writeFile(file, "hello\nworld\n", "utf8");
    const tool = new UnrestrictedReadTool();

    const first = await executeInThread(tool, "thread-a", { file_path: file });
    assert.notEqual(first.content, FILE_UNCHANGED_STUB);

    // 同一会话、同一区间的重复读取仍然走快捷返回
    const repeated = await executeInThread(tool, "thread-a", {
      file_path: file,
    });
    assert.equal(repeated.content, FILE_UNCHANGED_STUB);

    // 另一个会话从未读过该文件，必须拿到真实内容；「参考本次对话早前的读取结果」
    // 这句提示对该会话不成立，返回它等于让模型引用不存在的内容
    const otherThread = await executeInThread(tool, "thread-b", {
      file_path: file,
    });
    assert.notEqual(otherThread.content, FILE_UNCHANGED_STUB);
    assert.match(otherThread.content, /1\thello/);

    // 会话隔离同时保证双方各自的快捷返回不会互相顶掉
    const otherRepeated = await executeInThread(tool, "thread-b", {
      file_path: file,
    });
    assert.equal(otherRepeated.content, FILE_UNCHANGED_STUB);
  });

  void it("requires large files to be read in bounded ranges", async (test) => {
    const directory = await temporaryDirectory(test);
    const file = path.join(directory, "large.txt");
    const line = "y".repeat(100);
    await writeFile(
      file,
      `${line}\n`.repeat(Math.ceil(MAX_READ_SIZE_BYTES / 100) + 100),
      "utf8",
    );
    const tool = new UnrestrictedReadTool();

    await assert.rejects(execute(tool, { file_path: file }), /超过上限/);
    const ranged = await execute(tool, {
      file_path: file,
      offset: 1,
      limit: 50,
    });
    assert.match(ranged.content, new RegExp(`1\\t${line}`));
    assert.match(ranged.content, /后续用 Read/);
  });

  void it("allows only paths and symlinks that resolve inside a rooted tool", async (test) => {
    const container = await temporaryDirectory(test);
    const root = path.join(container, "root");
    await mkdir(path.join(root, "nested"), { recursive: true });
    const inside = path.join(root, "nested", "inside.txt");
    const outside = path.join(container, "outside.txt");
    await writeFile(inside, "inside\n", "utf8");
    await writeFile(outside, "secret\n", "utf8");
    await symlink(
      path.join("nested", "inside.txt"),
      path.join(root, "safe-link"),
    );
    await symlink(outside, path.join(root, "escape-link"));
    const canonicalRoot = await realpath(root);

    for (const input of [
      path.join("nested", "inside.txt"),
      inside,
      "safe-link",
    ]) {
      const tool = await createRootedReadTool(root);
      try {
        const result = await execute(tool, { file_path: input });
        assert.match(result.content, /inside/);
        assert.ok(result.preserve?.key.startsWith(canonicalRoot));
      } finally {
        await tool.close();
      }
    }
    const tool = await createRootedReadTool(root);
    test.after(async (): Promise<void> => tool.close());
    for (const input of [
      path.join("..", "outside.txt"),
      outside,
      "escape-link",
    ]) {
      await assert.rejects(execute(tool, { file_path: input }), /root|路径/);
    }
  });

  void it("rechecks the root boundary when a preserved symlink is fetched", async (test) => {
    const container = await temporaryDirectory(test);
    const root = path.join(container, "root");
    await mkdir(root);
    await writeFile(path.join(root, "inside.txt"), "safe\n", "utf8");
    const outside = path.join(container, "outside.txt");
    await writeFile(outside, "secret\n", "utf8");
    const link = path.join(root, "link.txt");
    await symlink("inside.txt", link);
    const tool = await createRootedReadTool(root);
    test.after(async (): Promise<void> => tool.close());

    const first = await execute(tool, { file_path: "link.txt" });
    assert.ok(first.preserve?.fetch);
    await rm(link);
    await symlink(outside, link);
    await assert.rejects(
      first.preserve.fetch(AbortSignal.timeout(1_000)),
      /root|路径/,
    );
  });

  void it("pins or fails closed when the configured root path is replaced", async (test) => {
    const container = await temporaryDirectory(test);
    const root = path.join(container, "root");
    const outside = path.join(container, "outside");
    await mkdir(root);
    await mkdir(outside);
    await writeFile(path.join(root, "marker.txt"), "safe\n", "utf8");
    await writeFile(path.join(outside, "marker.txt"), "secret\n", "utf8");
    const tool = await createRootedReadTool(root);
    test.after(async (): Promise<void> => tool.close());
    await rename(root, path.join(container, "moved-root"));
    await symlink(outside, root);

    try {
      const result = await execute(tool, { file_path: "marker.txt" });
      assert.match(result.content, /safe/);
      assert.doesNotMatch(result.content, /secret/);
    } catch (error: unknown) {
      assert.match(String(error), /root|路径/);
    }
  });

  void it("makes unrestricted authority explicit and validates rooted construction", async (test) => {
    const directory = await temporaryDirectory(test);
    const unrestricted = new UnrestrictedReadTool();
    assert.match(unrestricted.schema.function.description, /不限制路径/);
    await assert.rejects(createRootedReadTool(""), /root/);
    const file = path.join(directory, "not-a-directory");
    await writeFile(file, "x", "utf8");
    await assert.rejects(createRootedReadTool(file), /目录/);
  });
});
