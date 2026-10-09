import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { RuntimeContext } from "../../../src/pipeline/context/runtime-context.js";
import type { RuntimeNode } from "../../../src/pipeline/node/port/runtime-node.js";
import type { PipelineHook } from "../../../src/pipeline/hook/port/message-hook.js";
import { PipelineBuilder } from "../../../src/pipeline/pipeline/service/sequential-pipeline.js";

function newContext(): RuntimeContext {
  return new RuntimeContext({
    sessionId: "session-1",
    checkpointId: "checkpoint-1",
    userId: "user-1",
    requestId: "request-1",
    traceId: "trace-1",
    checkpointRevision: 0n,
    fencingToken: 0n,
    messages: [],
    llmContext: [],
  });
}

class RecordingNode implements RuntimeNode {
  public readonly name: string;
  readonly #calls: string[];
  readonly #error: Error | undefined;

  public constructor(name: string, calls: string[], error?: Error) {
    this.name = name;
    this.#calls = calls;
    this.#error = error;
  }

  public execute(): Promise<void> {
    this.#calls.push(`node:${this.name}`);
    return this.#error ? Promise.reject(this.#error) : Promise.resolve();
  }
}

class RecordingHook implements PipelineHook {
  readonly #calls: string[];
  readonly #failAt: string | undefined;

  public constructor(calls: string[], failAt?: string) {
    this.#calls = calls;
    this.#failAt = failAt;
  }

  public onPipelineStart(): Promise<void> {
    return this.#record("start");
  }

  public beforeNode(
    _context: RuntimeContext,
    node: RuntimeNode,
  ): Promise<void> {
    return this.#record(`before:${node.name}`);
  }

  public afterNode(
    _context: RuntimeContext,
    node: RuntimeNode,
    error: Error | undefined,
  ): Promise<void> {
    return this.#record(`after:${node.name}:${error ? "error" : "ok"}`);
  }

  public onPipelineEnd(
    _context: RuntimeContext,
    error: Error | undefined,
  ): Promise<void> {
    return this.#record(`end:${error ? "error" : "ok"}`);
  }

  #record(value: string): Promise<void> {
    this.#calls.push(value);
    return this.#failAt === value
      ? Promise.reject(new Error(`${value} failed`))
      : Promise.resolve();
  }
}

void describe("Runtime TypeScript sequential pipeline", () => {
  void it("runs hooks and nodes in deterministic order", async () => {
    const calls: string[] = [];
    const pipeline = new PipelineBuilder()
      .addHook(new RecordingHook(calls))
      .add(new RecordingNode("one", calls))
      .add(new RecordingNode("two", calls))
      .build();

    await pipeline.run(newContext(), AbortSignal.timeout(1_000));

    assert.deepEqual(calls, [
      "start",
      "before:one",
      "node:one",
      "after:one:ok",
      "before:two",
      "node:two",
      "after:two:ok",
      "end:ok",
    ]);
  });

  void it("runs all hooks in registration order", async () => {
    const calls: string[] = [];
    const pipeline = new PipelineBuilder()
      .addHook(new RecordingHook(calls))
      .addHook(new RecordingHook(calls))
      .add(new RecordingNode("one", calls))
      .build();

    await pipeline.run(newContext(), AbortSignal.timeout(1_000));
    assert.deepEqual(calls, [
      "start",
      "start",
      "before:one",
      "before:one",
      "node:one",
      "after:one:ok",
      "after:one:ok",
      "end:ok",
      "end:ok",
    ]);
  });

  void it("propagates before-node failures to end hooks and finally nodes", async () => {
    const calls: string[] = [];
    let finallyError: Error | undefined;
    const finallyNode: RuntimeNode = {
      name: "save",
      execute: (context: RuntimeContext): Promise<void> => {
        finallyError = context.pipelineError;
        calls.push("finally");
        return Promise.resolve();
      },
    };
    const pipeline = new PipelineBuilder()
      .addHook(new RecordingHook(calls, "before:one"))
      .add(new RecordingNode("one", calls))
      .addFinally(finallyNode)
      .build();

    await assert.rejects(
      pipeline.run(newContext(), AbortSignal.timeout(1_000)),
      /before:one failed/,
    );
    assert.equal(finallyError instanceof Error, true);
    assert.deepEqual(calls, ["start", "before:one", "end:error", "finally"]);
  });

  void it("runs end hooks and finally nodes after a start failure", async () => {
    const calls: string[] = [];
    const pipeline = new PipelineBuilder()
      .addHook(new RecordingHook(calls, "start"))
      .addFinally(new RecordingNode("finally", calls))
      .build();

    await assert.rejects(
      pipeline.run(newContext(), AbortSignal.timeout(1_000)),
      /start failed/,
    );
    assert.deepEqual(calls, ["start", "end:error", "node:finally"]);
  });

  void it("returns finally failures and uses a cleanup signal independent of request cancellation", async () => {
    const controller = new AbortController();
    controller.abort(new Error("request cancelled"));
    let cleanupAborted = true;
    const failure = new Error("save failed");
    const finallyNode: RuntimeNode = {
      name: "save",
      execute: (
        _context: RuntimeContext,
        signal: AbortSignal,
      ): Promise<void> => {
        cleanupAborted = signal.aborted;
        return Promise.reject(failure);
      },
    };
    const pipeline = new PipelineBuilder().addFinally(finallyNode).build();

    await assert.rejects(
      pipeline.run(newContext(), controller.signal),
      /save failed/,
    );
    assert.equal(cleanupAborted, false);
  });
});
