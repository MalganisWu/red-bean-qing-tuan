import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { ToolCallContext } from "../../../../src/pipeline/context/runtime-context.js";
import { TodoWriteTool } from "../../../../src/tool/builtin/todo-write/todo-write-tool.js";

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

const THREE_TODOS = [
  { content: "读取相关文件", status: "completed" },
  { content: "修改实现", status: "in_progress" },
  { content: "运行门禁", status: "pending" },
];

void describe("Runtime TypeScript todo-write tool", () => {
  void it("renders every item with its status marker in the given order", async () => {
    const tool = new TodoWriteTool();

    const result = await tool.execute(
      { todos: THREE_TODOS },
      contextFor("thread-a"),
      AbortSignal.timeout(5_000),
    );

    const lines = result.content.split("\n");
    assert.deepEqual(lines.slice(0, 3), [
      "[x] 读取相关文件",
      "[~] 修改实现",
      "[ ] 运行门禁",
    ]);
    // 顺序承载模型对执行次序的安排，不能被工具重排
    assert.match(result.content, /1\/3/);
  });

  void it("replaces the whole list rather than merging", async () => {
    const tool = new TodoWriteTool();
    await tool.execute(
      { todos: THREE_TODOS },
      contextFor("thread-a"),
      AbortSignal.timeout(5_000),
    );

    await tool.execute(
      { todos: [{ content: "只剩一项", status: "pending" }] },
      contextFor("thread-a"),
      AbortSignal.timeout(5_000),
    );

    assert.deepEqual(tool.current("thread-a"), [
      { content: "只剩一项", status: "pending" },
    ]);
  });

  void it("keeps lists separate per conversation and exposes them to the host", async () => {
    const tool = new TodoWriteTool();
    await tool.execute(
      { todos: THREE_TODOS },
      contextFor("thread-a"),
      AbortSignal.timeout(5_000),
    );

    assert.equal(tool.current("thread-b").length, 0);
    await tool.execute(
      { todos: [{ content: "另一个会话", status: "pending" }] },
      contextFor("thread-b"),
      AbortSignal.timeout(5_000),
    );

    assert.equal(tool.current("thread-a").length, 3);
    assert.equal(tool.current("thread-b").length, 1);
  });

  void it("accepts an empty list as an explicit clear", async () => {
    const tool = new TodoWriteTool();
    await tool.execute(
      { todos: THREE_TODOS },
      contextFor("thread-a"),
      AbortSignal.timeout(5_000),
    );

    const result = await tool.execute(
      { todos: [] },
      contextFor("thread-a"),
      AbortSignal.timeout(5_000),
    );

    assert.equal(tool.current("thread-a").length, 0);
    assert.match(result.content, /空|清空/);
  });

  void it("rejects invalid status and malformed input", async () => {
    const tool = new TodoWriteTool();
    const signal = AbortSignal.timeout(5_000);

    await assert.rejects(
      tool.execute(
        { todos: [{ content: "x", status: "doing" }] },
        contextFor("thread-a"),
        signal,
      ),
      /status/,
    );
    await assert.rejects(
      tool.execute(
        { todos: [{ content: "", status: "pending" }] },
        contextFor("thread-a"),
        signal,
      ),
      /content/,
    );
    await assert.rejects(
      tool.execute({ todos: "nope" }, contextFor("thread-a"), signal),
      /todos/,
    );
  });
});
