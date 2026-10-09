import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { JsonValue } from "../../../src/protocol/json.js";
import type {
  Tool,
  ToolCallContext,
  ToolResult,
} from "../../../src/tool/definition/tool.js";
import {
  MapToolDispatcher,
  TOOL_DISPATCH_ERROR_CODES,
  ToolDispatchError,
} from "../../../src/tool/dispatcher/service/map-tool-dispatcher.js";

class RecordingTool implements Tool {
  public readonly name = "record";
  public readonly schema = {
    type: "function",
    function: {
      name: "record",
      description: "record parameters",
      parameters: { type: "object" },
    },
  } as const;
  public received: JsonValue | undefined;

  public execute(params: JsonValue): Promise<ToolResult> {
    this.received = params;
    return Promise.resolve({ content: "ok" });
  }
}

const context: ToolCallContext = {
  threadId: "thread-1",
  userId: "user-1",
  requestId: "request-1",
  traceId: "trace-1",
  callId: "call-1",
  checkpointRevision: 0n,
  fencingToken: 0n,
};

void describe("Runtime TypeScript map tool dispatcher", () => {
  for (const argumentsJson of ["", "null"]) {
    void it(`normalizes ${JSON.stringify(argumentsJson)} arguments to an object`, async () => {
      const tool = new RecordingTool();
      const dispatcher = new MapToolDispatcher([tool]);
      const result = await dispatcher.dispatch(
        {
          id: "call-1",
          type: "function",
          function: { name: "record", arguments: argumentsJson },
        },
        context,
        AbortSignal.timeout(1_000),
      );

      assert.deepEqual(tool.received, {});
      assert.equal(result.content, "ok");
    });
  }

  void it("parses JSON arguments and rejects malformed input before execution", async () => {
    const tool = new RecordingTool();
    const dispatcher = new MapToolDispatcher([tool]);
    await dispatcher.dispatch(
      {
        id: "call-1",
        type: "function",
        function: { name: "record", arguments: '{"answer":42}' },
      },
      context,
      AbortSignal.timeout(1_000),
    );
    assert.deepEqual(tool.received, { answer: 42 });

    await assert.rejects(
      dispatcher.dispatch(
        {
          id: "call-2",
          type: "function",
          function: { name: "record", arguments: "{" },
        },
        context,
        AbortSignal.timeout(1_000),
      ),
      (error: unknown): boolean =>
        error instanceof ToolDispatchError &&
        error.code === TOOL_DISPATCH_ERROR_CODES.INVALID_ARGUMENTS,
    );
  });

  void it("returns a distinguishable error for an unknown tool", async () => {
    const dispatcher = new MapToolDispatcher([]);
    await assert.rejects(
      dispatcher.dispatch(
        {
          id: "call-1",
          type: "function",
          function: { name: "missing", arguments: "{}" },
        },
        context,
        AbortSignal.timeout(1_000),
      ),
      (error: unknown): boolean =>
        error instanceof ToolDispatchError &&
        error.code === TOOL_DISPATCH_ERROR_CODES.NOT_FOUND,
    );
  });
});
