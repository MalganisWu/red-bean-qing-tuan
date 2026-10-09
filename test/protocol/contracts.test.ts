import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  AGENT_RESULT_REASONS,
  AGENT_RESULT_METADATA_KEY,
} from "../../src/pipeline/execution/agent-result.js";
import {
  EVENT_TYPES,
  STATUS_CODES,
  serializeRuntimeEvent,
} from "../../src/protocol/event.js";
import { SIGNAL_KINDS } from "../../src/protocol/interrupt.js";
import type { RunIdentity } from "../../src/protocol/run-identity.js";
import { createInterruptSignal } from "../../src/pipeline/interrupt/interrupt-factory.js";
import { toLlmToolSchema } from "../../src/tool/tool-schema-presenter.js";

void describe("Runtime TypeScript core contracts", () => {
  void it("uses one neutral run identity across capability boundaries", () => {
    const identity: RunIdentity = {
      threadId: "thread-1",
      userId: "user-1",
      requestId: "request-1",
      traceId: "trace-1",
    };

    assert.deepEqual(Object.keys(identity), [
      "threadId",
      "userId",
      "requestId",
      "traceId",
    ]);
  });

  void it("preserves agent result strings and metadata key", () => {
    assert.deepEqual(Object.values(AGENT_RESULT_REASONS), [
      "completed",
      "cancelled",
      "max_iterations",
      "llm_error",
      "hook_fatal",
      "awaiting_user",
    ]);
    assert.equal(AGENT_RESULT_METADATA_KEY, "agent_result");
  });

  void it("serializes structured status fields without presentation text", () => {
    const payload = serializeRuntimeEvent({
      type: EVENT_TYPES.STATUS,
      code: STATUS_CODES.LLM_RETRY,
      attempt: 2,
      maxAttempts: 11,
    });

    assert.deepEqual(payload, {
      code: "llm_retry",
      attempt: 2,
      max_attempts: 11,
    });
    assert.equal("content" in payload, false);
  });

  void it("does not leak interrupting metadata into the LLM tool schema", () => {
    const schema = toLlmToolSchema({
      type: "function",
      function: {
        name: "sys_ask_user",
        description: "向用户提问",
        parameters: { type: "object", properties: {} },
      },
      interrupting: true,
    });

    assert.deepEqual(schema, {
      type: "function",
      function: {
        name: "sys_ask_user",
        description: "向用户提问",
        parameters: { type: "object", properties: {} },
      },
    });
    assert.equal("interrupting" in schema, false);
  });

  void it("creates a JSON-safe interrupt signal and rejects non-JSON payloads", () => {
    const signal = createInterruptSignal({
      kind: "ask",
      questions: ["继续吗？"],
    });

    assert.equal(signal.kind, SIGNAL_KINDS.INTERRUPT);
    assert.deepEqual(signal.payload, { kind: "ask", questions: ["继续吗？"] });
    assert.throws(() => createInterruptSignal({ invalid: 1n }), /JSON/);
  });
});
