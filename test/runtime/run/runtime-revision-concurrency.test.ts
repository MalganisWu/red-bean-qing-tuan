import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { MemoryCheckpointStore } from "../../../src/runtime/checkpoint/checkpoint.js";
import { RUNTIME_ERROR_CODES } from "../../../src/runtime/run/error/runtime-error.js";
import {
  AgentRuntime,
  RuntimeExecutionError,
  type ResumeRequest,
} from "../../../src/runtime/public-api.js";
import {
  AskTool,
  BlockingAdapter,
  CanonicalResponseStore,
  FailingSaveStore,
  NonFencingStore,
  ProbeDispatcher,
  ResumableBlockingAdapter,
  SequenceAdapter,
  activeSignal,
  hasRuntimeCode,
  suspendedState,
  toolCall,
} from "./runtime-revision.fixtures.js";
import type { ToolSchema } from "../../../src/tool/definition/tool.js";

void describe("Runtime TypeScript revision and concurrency semantics", () => {
  void it("serializes runs for the same thread", async () => {
    const adapter = new BlockingAdapter();
    const runtime = new AgentRuntime({ model: adapter });
    const first = runtime.run(
      { threadId: "same", input: "one" },
      activeSignal(),
    );
    await adapter.entered[0].promise;
    const second = runtime.run(
      { threadId: "same", input: "two" },
      activeSignal(),
    );

    const enteredEarly = await Promise.race([
      adapter.entered[1].promise.then((): boolean => true),
      new Promise<boolean>((resolve): void => {
        setTimeout((): void => resolve(false), 25);
      }),
    ]);
    assert.equal(enteredEarly, false);
    adapter.releases[0].resolve();
    await first;
    await adapter.entered[1].promise;
    adapter.releases[1].resolve();
    await second;
    assert.equal(adapter.maxActive, 1);
  });

  void it("uses CAS and propagates revision and fencing to tools", async () => {
    const adapter = new SequenceAdapter([
      [toolCall("probe", "call-1")],
      [{ content: "first" }],
      [{ content: "second" }],
    ]);
    const dispatcher = new ProbeDispatcher();
    const schema: ToolSchema = {
      type: "function",
      function: { name: "probe", description: "", parameters: {} },
    };
    const runtime = new AgentRuntime({
      model: adapter,
      toolSchemas: [schema],
      toolDispatcher: dispatcher,
      checkpointStore: new MemoryCheckpointStore(),
    });

    const first = await runtime.run(
      {
        threadId: "cas",
        input: "one",
        expectedRevision: 0n,
        fencingToken: 7n,
      },
      activeSignal(),
    );
    assert.equal(first.revision, 1n);
    assert.equal(dispatcher.context?.checkpointRevision, 0n);
    assert.equal(dispatcher.context?.fencingToken, 7n);

    const second = await runtime.run(
      {
        threadId: "cas",
        input: "two",
        expectedRevision: 1n,
        fencingToken: 7n,
      },
      activeSignal(),
    );
    assert.equal(second.revision, 2n);
    const callsBeforeConflict = adapter.requests.length;
    await assert.rejects(
      runtime.run(
        {
          threadId: "cas",
          input: "stale",
          expectedRevision: 1n,
          fencingToken: 7n,
        },
        activeSignal(),
      ),
      (error: unknown): boolean =>
        hasRuntimeCode(error, RUNTIME_ERROR_CODES.REVISION_CONFLICT),
    );
    assert.equal(adapter.requests.length, callsBeforeConflict);
    await assert.rejects(
      runtime.run({ threadId: "cas", input: "downgrade" }, activeSignal()),
      (error: unknown): boolean =>
        hasRuntimeCode(error, RUNTIME_ERROR_CODES.STALE_FENCE),
    );
  });

  void it("uses the response committed by the checkpoint store", async () => {
    const adapter = new SequenceAdapter([
      [toolCall("ask", "call-resume")],
      [{ content: "done" }],
    ]);
    const store = new CanonicalResponseStore(new MemoryCheckpointStore());
    const runtime = new AgentRuntime({
      model: adapter,
      tools: [new AskTool()],
      checkpointStore: store,
    });
    await runtime.run(
      { threadId: "canonical", input: "start", fencingToken: 9n },
      activeSignal(),
    );
    const resumed = await runtime.resume(
      {
        threadId: "canonical",
        requestId: "resume-1",
        interruptId: "call-resume",
        response: "untrusted",
        expectedRevision: 1n,
        fencingToken: 9n,
      },
      activeSignal(),
    );
    assert.equal(resumed.revision, 3n);
    assert.equal(adapter.requests.at(-1)?.messages.at(-1)?.content, "stored");
  });

  void it("returns a local diagnostic checkpoint when saving fails", async () => {
    const runtime = new AgentRuntime({
      model: new SequenceAdapter([[{ content: "locally complete" }]]),
      checkpointStore: new FailingSaveStore(new MemoryCheckpointStore()),
    });
    await assert.rejects(
      runtime.run({ threadId: "save-fails", input: "go" }, activeSignal()),
      (error: unknown): boolean => {
        assert.equal(error instanceof RuntimeExecutionError, true);
        if (!(error instanceof RuntimeExecutionError)) return false;
        assert.match(error.message, /save unavailable/i);
        assert.equal(error.result.revision, 0n);
        assert.equal(error.result.checkpoint.threadId, "save-fails");
        assert.equal(error.result.output, "locally complete");
        return true;
      },
    );
  });

  void it("rejects stateless revision and fencing before calling the model", async () => {
    for (const request of [
      { input: "go", expectedRevision: 0n },
      { input: "go", fencingToken: 1n },
    ]) {
      const adapter = new SequenceAdapter([[{ content: "unused" }]]);
      const runtime = new AgentRuntime({ model: adapter });
      await assert.rejects(runtime.run(request, activeSignal()));
      assert.equal(adapter.requests.length, 0);
    }
  });

  void it("propagates unsupported store fencing before calling the model", async () => {
    const adapter = new SequenceAdapter([[{ content: "unused" }]]);
    const runtime = new AgentRuntime({
      model: adapter,
      checkpointStore: new NonFencingStore(new MemoryCheckpointStore()),
    });

    await assert.rejects(
      runtime.run(
        {
          threadId: "unsupported-fence",
          input: "go",
          fencingToken: 1n,
        },
        activeSignal(),
      ),
      (error: unknown): boolean =>
        hasRuntimeCode(error, RUNTIME_ERROR_CODES.FENCING_UNSUPPORTED),
    );
    assert.equal(adapter.requests.length, 0);
  });

  void it("replays a completed resume after Runtime replacement", async () => {
    const store = new MemoryCheckpointStore();
    const adapter = new SequenceAdapter([
      [toolCall("ask", "call-durable")],
      [{ content: "durable result" }],
    ]);
    const runtime = new AgentRuntime({
      model: adapter,
      tools: [new AskTool()],
      checkpointStore: store,
    });
    await runtime.run({ threadId: "durable", input: "start" }, activeSignal());
    const request: ResumeRequest = {
      threadId: "durable",
      requestId: "resume-1",
      interruptId: "call-durable",
      response: "yes",
    };
    const completed = await runtime.resume(request, activeSignal());
    assert.equal(completed.output, "durable result");

    const replacementModel = new SequenceAdapter([]);
    const replacement = new AgentRuntime({
      model: replacementModel,
      tools: [new AskTool()],
      checkpointStore: store,
    });
    const replayed = await replacement.resume(request, activeSignal());
    assert.equal(replayed.output, "durable result");
    assert.equal(replacementModel.requests.length, 0);
  });

  void it("executes one concurrent resume and replays its result", async () => {
    const model = new ResumableBlockingAdapter();
    const store = new MemoryCheckpointStore();
    const runtime = new AgentRuntime({
      model,
      tools: [new AskTool()],
      checkpointStore: store,
    });
    await runtime.run({ threadId: "resume", input: "start" }, activeSignal());
    const request: ResumeRequest = {
      threadId: "resume",
      requestId: "request-1",
      interruptId: "call-once",
      response: "yes",
    };
    const first = runtime.resume(request, activeSignal());
    await model.resumeEntered.promise;
    const second = runtime.resume(request, activeSignal());
    model.resumeRelease.resolve();
    const [firstResult, secondResult] = await Promise.all([first, second]);
    assert.equal(firstResult.output, "resumed once");
    assert.equal(secondResult.output, "resumed once");
    assert.equal(model.resumeCalls, 1);
  });

  void it("keeps stateless receipt keys isolated across adversarial IDs", async () => {
    const adapter = new SequenceAdapter([
      [{ content: "first" }],
      [{ content: "second" }],
    ]);
    const runtime = new AgentRuntime({ model: adapter });
    const first: ResumeRequest = {
      threadId: "a",
      requestId: "b\u0000request\u0000c",
      interruptId: "call-a",
      response: "yes",
      state: suspendedState("a", "call-a"),
    };
    const second: ResumeRequest = {
      threadId: "a\u0000request\u0000b",
      requestId: "c",
      interruptId: "call-b",
      response: "yes",
      state: suspendedState("a\u0000request\u0000b", "call-b"),
    };
    assert.equal((await runtime.resume(first, activeSignal())).output, "first");
    assert.equal(
      (await runtime.resume(second, activeSignal())).output,
      "second",
    );
  });

  void it("requires a request ID for stored resumes before calling the model", async () => {
    const adapter = new SequenceAdapter([[{ content: "unused" }]]);
    const runtime = new AgentRuntime({
      model: adapter,
      checkpointStore: new MemoryCheckpointStore(),
    });

    await assert.rejects(
      runtime.resume(
        {
          threadId: "missing-request-id",
          interruptId: "call",
          response: "yes",
        },
        activeSignal(),
      ),
      /request ID is required/i,
    );
    assert.equal(adapter.requests.length, 0);
  });
});
