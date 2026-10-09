import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  CHILD_RUN_STATUSES,
  ChildRunError,
  DelegationTool,
  type ChildRunRequest,
  type ChildRunResult,
  type ChildRunner,
} from "../../../src/tool/delegation/service/delegation-tool.js";
import type { ToolCallContext } from "../../../src/pipeline/context/runtime-context.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

class RecordingRunner implements ChildRunner {
  public readonly requests: ChildRunRequest[] = [];
  public result: ChildRunResult = {
    status: CHILD_RUN_STATUSES.COMPLETED,
    output: "done",
  };
  public error: Error | undefined;

  public runChild(
    request: ChildRunRequest,
    _signal: AbortSignal,
  ): Promise<ChildRunResult> {
    this.requests.push(request);
    return this.error
      ? Promise.reject(
          new ChildRunError(this.error.message, this.result, this.error),
        )
      : Promise.resolve(this.result);
  }
}

const parentEventSink: NonNullable<
  ToolCallContext["eventSink"]
> = (): void => {};

const context: ToolCallContext = {
  threadId: "thread-1",
  userId: "user-1",
  requestId: "request-1",
  traceId: "trace-1",
  callId: "parent-call",
  checkpointRevision: 0n,
  fencingToken: 0n,
  eventSink: parentEventSink,
};

function parseObject(content: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(content);
  assert.equal(isRecord(parsed), true);
  if (!isRecord(parsed)) assert.fail("expected a JSON object");
  return parsed;
}

void describe("Runtime TypeScript delegation tool", () => {
  void it("maps neutral invocation context into a structured child request", async () => {
    const runner = new RecordingRunner();
    runner.result = {
      status: CHILD_RUN_STATUSES.COMPLETED,
      executionId: "child-1",
      output: "child output",
    };
    const tool = new DelegationTool({
      agentId: "researcher",
      name: "delegate_research",
      description: "delegate",
      runner,
    });

    const result = await tool.execute(
      {
        instruction: "research this",
        context: "known facts",
        expected_format: "markdown",
      },
      context,
      AbortSignal.timeout(1_000),
    );
    assert.equal(result.content, "child output\n\n[execution_id: child-1]");
    assert.deepEqual(runner.requests[0], {
      agentId: "researcher",
      executionId: "",
      parentCallId: "parent-call",
      threadId: "thread-1",
      userId: "user-1",
      requestId: "request-1",
      traceId: "trace-1",
      instruction: "research this",
      context: "known facts",
      expectedFormat: "markdown",
      eventSink: parentEventSink,
    });
  });

  void it("forwards an empty resume response and returns a structured suspension", async () => {
    const runner = new RecordingRunner();
    runner.result = {
      status: CHILD_RUN_STATUSES.SUSPENDED,
      executionId: "child-existing",
      interrupt: {
        toolCallId: "child-call-2",
        toolName: "approval",
        arguments: { scope: "deploy" },
        payload: { risk: "high" },
      },
    };
    const tool = new DelegationTool({
      agentId: "writer",
      name: "delegate_writer",
      runner,
    });
    const result = await tool.execute(
      {
        execution_id: "child-existing",
        interrupt_id: "child-call-1",
        response: "",
      },
      context,
      AbortSignal.timeout(1_000),
    );

    assert.deepEqual(runner.requests[0]?.resume, {
      interruptId: "child-call-1",
      response: "",
    });
    assert.deepEqual(parseObject(result.content), {
      status: "awaiting_user",
      execution_id: "child-existing",
      interrupt_id: "child-call-2",
      interrupt: {
        tool_call_id: "child-call-2",
        tool_name: "approval",
        arguments: { scope: "deploy" },
        payload: { risk: "high" },
      },
    });
  });

  void it("validates parameter combinations before invoking the child", async () => {
    for (const params of [
      {},
      { execution_id: "child", response: "yes" },
      { execution_id: "child", interrupt_id: "call" },
      { instruction: "work", interrupt_id: "call", response: "yes" },
      { instruction: 42 },
    ]) {
      const runner = new RecordingRunner();
      const tool = new DelegationTool({
        agentId: "writer",
        name: "delegate_writer",
        runner,
      });
      await assert.rejects(
        tool.execute(params, context, AbortSignal.timeout(1_000)),
      );
      assert.equal(runner.requests.length, 0);
    }
  });

  void it("exposes only the generic resume schema", () => {
    const tool = new DelegationTool({
      agentId: "writer",
      name: "delegate_writer",
      runner: new RecordingRunner(),
    });
    const properties = tool.schema.function.parameters["properties"];
    assert.equal(typeof properties, "object");
    assert.match(JSON.stringify(properties), /interrupt_id/);
    assert.match(JSON.stringify(properties), /response/);
    assert.doesNotMatch(JSON.stringify(properties), /answers/);
  });

  void it("turns runner and terminal child failures into structured tool results", async () => {
    const runner = new RecordingRunner();
    runner.result = {
      status: CHILD_RUN_STATUSES.FAILED,
      executionId: "child-failed",
      partialOutput: "partial",
    };
    runner.error = new Error("remote runtime unavailable");
    const tool = new DelegationTool({
      agentId: "remote",
      name: "delegate_remote",
      runner,
    });
    const failed = parseObject(
      (
        await tool.execute(
          { instruction: "work" },
          context,
          AbortSignal.timeout(1_000),
        )
      ).content,
    );
    assert.deepEqual(failed, {
      status: "failed",
      error: "remote runtime unavailable",
      execution_id: "child-failed",
      partial_output: "partial",
    });

    runner.error = undefined;
    runner.result = {
      status: CHILD_RUN_STATUSES.COMPLETED,
      executionId: "child-1",
    };
    const empty = parseObject(
      (
        await tool.execute(
          { instruction: "work" },
          context,
          AbortSignal.timeout(1_000),
        )
      ).content,
    );
    assert.match(String(empty["error"]), /未产生有效输出/);
  });

  void it("rejects mismatched resume IDs and invalid suspended results", async () => {
    const runner = new RecordingRunner();
    const tool = new DelegationTool({
      agentId: "worker",
      name: "delegate_worker",
      runner,
    });
    runner.result = {
      status: CHILD_RUN_STATUSES.COMPLETED,
      executionId: "child-other",
      output: "wrong child",
    };
    const mismatch = parseObject(
      (
        await tool.execute(
          { execution_id: "child-expected", instruction: "continue" },
          context,
          AbortSignal.timeout(1_000),
        )
      ).content,
    );
    assert.match(String(mismatch["error"]), /不一致/);

    for (const result of [
      {
        status: CHILD_RUN_STATUSES.SUSPENDED,
        interrupt: {
          toolCallId: "call-1",
          toolName: "approval",
          arguments: {},
          payload: {},
        },
      },
      { status: CHILD_RUN_STATUSES.SUSPENDED, executionId: "child-1" },
      {
        status: CHILD_RUN_STATUSES.SUSPENDED,
        executionId: "child-1",
        interrupt: {
          toolCallId: "",
          toolName: "approval",
          arguments: {},
          payload: {},
        },
      },
    ] satisfies readonly ChildRunResult[]) {
      runner.result = result;
      const invalid = parseObject(
        (
          await tool.execute(
            { instruction: "work" },
            context,
            AbortSignal.timeout(1_000),
          )
        ).content,
      );
      assert.equal(invalid["status"], "failed");
    }
  });

  void it("supports one-shot completion and validates constructor fields", async () => {
    const runner = new RecordingRunner();
    const tool = new DelegationTool({
      agentId: "oneshot",
      name: "delegate_oneshot",
      runner,
    });
    assert.equal(
      (
        await tool.execute(
          { instruction: "work" },
          context,
          AbortSignal.timeout(1_000),
        )
      ).content,
      "done",
    );
    assert.throws(
      (): DelegationTool =>
        new DelegationTool({
          agentId: "",
          name: "delegate",
          runner,
        }),
    );
    assert.throws(
      (): DelegationTool =>
        new DelegationTool({ agentId: "agent", name: "", runner }),
    );
  });
});
