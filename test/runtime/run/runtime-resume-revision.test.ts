import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  CHECKPOINT_STATUSES,
  MemoryCheckpointStore,
} from "../../../src/runtime/checkpoint/checkpoint.js";
import { RUNTIME_ERROR_CODES } from "../../../src/runtime/run/error/runtime-error.js";
import {
  AgentRuntime,
  RuntimeExecutionError,
  type ResumeRequest,
} from "../../../src/runtime/public-api.js";
import {
  AskTool,
  FailingResumeAdapter,
  ResumableBlockingAdapter,
  SequenceAdapter,
  activeSignal,
  hasRuntimeCode,
  suspendedState,
} from "./runtime-revision.fixtures.js";

void describe("Runtime TypeScript resume revision semantics", () => {
  void it("allows later stateless interrupts while preserving replay isolation", async () => {
    const adapter = new SequenceAdapter([
      [{ content: "first done" }],
      [{ content: "second done" }],
    ]);
    const runtime = new AgentRuntime({ model: adapter });
    const first: ResumeRequest = {
      threadId: "stateless-receipts",
      requestId: "request-1",
      interruptId: "call-1",
      response: "yes",
      state: suspendedState("stateless-receipts", "call-1"),
    };
    const second: ResumeRequest = {
      threadId: "stateless-receipts",
      requestId: "request-2",
      interruptId: "call-2",
      response: "no",
      state: suspendedState("stateless-receipts", "call-2"),
    };

    assert.equal(
      (await runtime.resume(first, activeSignal())).output,
      "first done",
    );
    assert.equal(
      (await runtime.resume(second, activeSignal())).output,
      "second done",
    );
    assert.equal(
      (await runtime.resume(first, activeSignal())).output,
      "first done",
    );
    await assert.rejects(
      runtime.resume({ ...first, response: "changed" }, activeSignal()),
      (error: unknown): boolean =>
        hasRuntimeCode(error, RUNTIME_ERROR_CODES.IDEMPOTENCY_CONFLICT),
    );
    await assert.rejects(
      runtime.resume({ ...first, userId: "intruder" }, activeSignal()),
      (error: unknown): boolean =>
        hasRuntimeCode(error, RUNTIME_ERROR_CODES.CHECKPOINT_NOT_FOUND),
    );
    assert.equal(adapter.requests.length, 2);
  });

  void it("rejects cross-runtime in-progress and conflicting resumes before the second model", async () => {
    const ownerModel = new ResumableBlockingAdapter();
    const store = new MemoryCheckpointStore();
    const owner = new AgentRuntime({
      model: ownerModel,
      tools: [new AskTool()],
      checkpointStore: store,
    });
    await owner.run(
      { threadId: "in-progress", input: "start" },
      activeSignal(),
    );
    const request: ResumeRequest = {
      threadId: "in-progress",
      requestId: "resume-shared",
      interruptId: "call-once",
      response: "yes",
    };
    const pending = owner.resume(request, activeSignal());
    await ownerModel.resumeEntered.promise;

    const contenderModel = new SequenceAdapter([[{ content: "unused" }]]);
    const contender = new AgentRuntime({
      model: contenderModel,
      tools: [new AskTool()],
      checkpointStore: store,
    });
    await assert.rejects(
      contender.resume(request, activeSignal()),
      (error: unknown): boolean => {
        assert.equal(error instanceof RuntimeExecutionError, true);
        if (!(error instanceof RuntimeExecutionError)) return false;
        assert.equal(error.result.revision, 2n);
        return hasRuntimeCode(error, RUNTIME_ERROR_CODES.RESUME_IN_PROGRESS);
      },
    );
    await assert.rejects(
      contender.resume({ ...request, response: "no" }, activeSignal()),
      (error: unknown): boolean =>
        hasRuntimeCode(error, RUNTIME_ERROR_CODES.IDEMPOTENCY_CONFLICT),
    );
    assert.equal(contenderModel.requests.length, 0);

    ownerModel.resumeRelease.resolve();
    assert.equal((await pending).revision, 3n);
  });

  void it("rejects an owner mismatch before calling the model", async () => {
    const store = new MemoryCheckpointStore();
    await store.save(
      {
        checkpoint: {
          ...suspendedState("owned-runtime", "call-owned"),
          userId: "alice",
          interrupt: undefined,
          status: CHECKPOINT_STATUSES.COMPLETED,
        },
        expectedRevision: 0n,
        fencingToken: 0n,
      },
      activeSignal(),
    );
    const adapter = new SequenceAdapter([[{ content: "unused" }]]);
    const runtime = new AgentRuntime({
      model: adapter,
      checkpointStore: store,
    });

    await assert.rejects(
      runtime.run(
        {
          threadId: "owned-runtime",
          userId: "bob",
          input: "must not execute",
        },
        activeSignal(),
      ),
      (error: unknown): boolean =>
        hasRuntimeCode(error, RUNTIME_ERROR_CODES.CHECKPOINT_NOT_FOUND),
    );
    assert.equal(adapter.requests.length, 0);
  });

  void it("rebuilds an anonymous tombstone for a named owner", async () => {
    const store = new MemoryCheckpointStore();
    const created = await store.save(
      {
        checkpoint: {
          ...suspendedState("anonymous-tombstone", "call-old"),
          userId: "",
          interrupt: undefined,
          status: CHECKPOINT_STATUSES.COMPLETED,
        },
        expectedRevision: 0n,
        fencingToken: 0n,
      },
      activeSignal(),
    );
    const deletedRevision = await store.delete(
      {
        threadId: "anonymous-tombstone",
        userId: "",
        expectedRevision: created.revision,
        fencingToken: 0n,
      },
      activeSignal(),
    );
    const runtime = new AgentRuntime({
      model: new SequenceAdapter([[{ content: "rebuilt" }]]),
      checkpointStore: store,
    });

    const rebuilt = await runtime.run(
      {
        threadId: "anonymous-tombstone",
        userId: "new-owner",
        input: "start",
        expectedRevision: deletedRevision,
      },
      activeSignal(),
    );
    assert.equal(rebuilt.output, "rebuilt");
    assert.equal(rebuilt.revision, deletedRevision + 1n);
    assert.equal(rebuilt.checkpoint.userId, "new-owner");
  });

  void it("rejects a stale fencing token on the final resume save", async () => {
    const model = new ResumableBlockingAdapter();
    const store = new MemoryCheckpointStore();
    const runtime = new AgentRuntime({
      model,
      tools: [new AskTool()],
      checkpointStore: store,
    });
    await runtime.run(
      { threadId: "stale-final", input: "start", fencingToken: 1n },
      activeSignal(),
    );
    const pending = runtime.resume(
      {
        threadId: "stale-final",
        requestId: "resume-stale",
        interruptId: "call-once",
        response: "yes",
        fencingToken: 1n,
      },
      activeSignal(),
    );
    await model.resumeEntered.promise;
    const claimed = await store.load(
      { threadId: "stale-final", userId: "", fencingToken: 2n },
      activeSignal(),
    );
    assert.equal(claimed.revision, 2n);
    model.resumeRelease.resolve();

    await assert.rejects(pending, (error: unknown): boolean => {
      assert.equal(error instanceof RuntimeExecutionError, true);
      if (!(error instanceof RuntimeExecutionError)) return false;
      assert.equal(error.result.revision, 0n);
      return hasRuntimeCode(error, RUNTIME_ERROR_CODES.STALE_FENCE);
    });
  });

  void it("replays a stored failed resume without calling a replacement model", async () => {
    const store = new MemoryCheckpointStore();
    const failingModel = new FailingResumeAdapter();
    const runtime = new AgentRuntime({
      model: failingModel,
      tools: [new AskTool()],
      checkpointStore: store,
    });
    await runtime.run(
      { threadId: "failed-replay", input: "start" },
      activeSignal(),
    );
    const request: ResumeRequest = {
      threadId: "failed-replay",
      requestId: "failed-request",
      interruptId: "call-failure",
      response: "yes",
    };
    await assert.rejects(
      runtime.resume(request, activeSignal()),
      (error: unknown): boolean => {
        assert.equal(error instanceof RuntimeExecutionError, true);
        if (!(error instanceof RuntimeExecutionError)) return false;
        assert.equal(error.result.status, CHECKPOINT_STATUSES.FAILED);
        assert.equal(error.result.revision, 3n);
        return true;
      },
    );

    const replacementModel = new SequenceAdapter([[{ content: "unused" }]]);
    const replacement = new AgentRuntime({
      model: replacementModel,
      tools: [new AskTool()],
      checkpointStore: store,
    });
    await assert.rejects(
      replacement.resume(request, activeSignal()),
      (error: unknown): boolean => {
        assert.equal(error instanceof RuntimeExecutionError, true);
        if (!(error instanceof RuntimeExecutionError)) return false;
        assert.equal(error.result.status, CHECKPOINT_STATUSES.FAILED);
        assert.equal(error.result.revision, 3n);
        return hasRuntimeCode(error, RUNTIME_ERROR_CODES.REPLAYED_FAILURE);
      },
    );
    assert.equal(replacementModel.requests.length, 0);
  });

  void it("replays a stored cancelled resume without calling a replacement model", async () => {
    const store = new MemoryCheckpointStore();
    const model = new ResumableBlockingAdapter();
    const runtime = new AgentRuntime({
      model,
      tools: [new AskTool()],
      checkpointStore: store,
    });
    await runtime.run(
      { threadId: "cancelled-replay", input: "start" },
      activeSignal(),
    );
    const request: ResumeRequest = {
      threadId: "cancelled-replay",
      requestId: "cancelled-request",
      interruptId: "call-once",
      response: "yes",
    };
    const controller = new AbortController();
    const pending = runtime.resume(request, controller.signal);
    await model.resumeEntered.promise;
    controller.abort(new Error("cancelled"));
    await assert.rejects(pending, (error: unknown): boolean => {
      assert.equal(error instanceof RuntimeExecutionError, true);
      if (!(error instanceof RuntimeExecutionError)) return false;
      assert.equal(error.result.status, CHECKPOINT_STATUSES.CANCELLED);
      assert.equal(error.result.revision, 3n);
      return true;
    });

    const replacementModel = new SequenceAdapter([[{ content: "unused" }]]);
    const replacement = new AgentRuntime({
      model: replacementModel,
      tools: [new AskTool()],
      checkpointStore: store,
    });
    await assert.rejects(
      replacement.resume(request, activeSignal()),
      (error: unknown): boolean => {
        assert.equal(error instanceof RuntimeExecutionError, true);
        if (!(error instanceof RuntimeExecutionError)) return false;
        assert.equal(error.result.status, CHECKPOINT_STATUSES.CANCELLED);
        assert.equal(error.result.revision, 3n);
        return hasRuntimeCode(error, RUNTIME_ERROR_CODES.REPLAYED_FAILURE);
      },
    );
    assert.equal(replacementModel.requests.length, 0);
  });
});
