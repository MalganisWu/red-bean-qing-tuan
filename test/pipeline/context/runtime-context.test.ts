import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  RuntimeContext,
  emitToolCallEvent,
} from "../../../src/pipeline/context/runtime-context.js";
import type { RuntimeNode } from "../../../src/pipeline/node/port/runtime-node.js";
import { EVENT_TYPES, type RuntimeEvent } from "../../../src/protocol/event.js";
import {
  NoopMessageHook,
  NoopPipelineHook,
} from "../../../src/pipeline/hook/service/noop-message-hooks.js";

void describe("Runtime TypeScript context and hook contracts", () => {
  void it("uses the host-provided checkpoint key and forwards events", () => {
    const events: RuntimeEvent[] = [];
    const context = new RuntimeContext({
      sessionId: "session-1",
      checkpointId: "checkpoint-1",
      userId: "user-1",
      requestId: "request-1",
      traceId: "trace-1",
      checkpointRevision: 4n,
      fencingToken: 9n,
      messages: [],
      llmContext: [],
      eventSink: (event: RuntimeEvent): void => {
        events.push(event);
      },
    });

    assert.equal(context.checkpointKey(), "checkpoint-1");
    context.emit({ type: EVENT_TYPES.TOKEN, content: "hello" });
    emitToolCallEvent(
      {
        threadId: "session-1",
        userId: "user-1",
        requestId: "request-1",
        traceId: "trace-1",
        callId: "call-1",
        checkpointRevision: 4n,
        fencingToken: 9n,
        eventSink: (event: RuntimeEvent): void => {
          events.push(event);
        },
      },
      { type: EVENT_TYPES.STATUS, code: "thinking" },
    );

    assert.deepEqual(events, [
      { type: "token", content: "hello" },
      { type: "status", code: "thinking" },
    ]);
  });

  void it("provides explicit no-op hook implementations", async () => {
    const context = new RuntimeContext({
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
    const node: RuntimeNode = {
      name: "noop",
      execute: (): Promise<void> => Promise.resolve(),
    };
    const messageHook = new NoopMessageHook();
    const pipelineHook = new NoopPipelineHook();
    const message = { role: "user", content: "hello" } as const;

    await messageHook.onUserMessage(
      context,
      message,
      AbortSignal.timeout(1_000),
    );
    await messageHook.onAssistantMessage(
      context,
      message,
      AbortSignal.timeout(1_000),
    );
    await messageHook.onToolMessage(
      context,
      message,
      AbortSignal.timeout(1_000),
    );
    await pipelineHook.onPipelineStart(context, AbortSignal.timeout(1_000));
    await pipelineHook.beforeNode(context, node, AbortSignal.timeout(1_000));
    await pipelineHook.afterNode(
      context,
      node,
      undefined,
      AbortSignal.timeout(1_000),
    );
    await pipelineHook.onPipelineEnd(
      context,
      undefined,
      AbortSignal.timeout(1_000),
    );
  });
});
