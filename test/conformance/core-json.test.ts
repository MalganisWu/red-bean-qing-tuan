import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";

import { serializeModelParams } from "../../src/llm/codec/model-params-serializer.js";
import { serializeContentRef } from "../../src/protocol/content-reference.js";
import {
  EVENT_TYPES,
  STATUS_CODES,
  serializeRuntimeEvent,
} from "../../src/protocol/event.js";
import { serializeInterrupt } from "../../src/protocol/interrupt.js";
import { serializeRawMessage } from "../../src/protocol/message.js";
import { toLlmToolSchema } from "../../src/tool/tool-schema-presenter.js";

void describe("core JSON conformance", () => {
  void it("matches the stable serialization fixtures", async () => {
    const source = await readFile(
      path.join(process.cwd(), "testdata/conformance/core-json.json"),
      "utf8",
    );
    const expected: unknown = JSON.parse(source);
    const actual = {
      raw_message: serializeRawMessage({
        role: "assistant",
        content: "hello",
        toolCalls: [
          {
            id: "call-1",
            type: "function",
            function: {
              name: "sys_ask_user",
              arguments: '{"questions":["继续吗？"]}',
            },
          },
        ],
      }),
      status_event: serializeRuntimeEvent({
        type: EVENT_TYPES.STATUS,
        code: STATUS_CODES.LLM_RETRY,
        attempt: 2,
        maxAttempts: 11,
      }),
      tool_schema: toLlmToolSchema({
        type: "function",
        function: {
          name: "sys_ask_user",
          description: "向用户提问",
          parameters: { type: "object", properties: {} },
        },
        interrupting: true,
      }),
      content_ref: serializeContentRef({
        kind: "object",
        key: "docs/1",
        version: "v2",
        meta: { bucket: "agent" },
        timestamp: 1_788_480_000,
      }),
      model_params: serializeModelParams({
        temperature: 0,
        maxTokens: 0,
        contextWindow: 128_000,
        thinking: false,
      }),
      interrupt: serializeInterrupt({
        toolCallId: "call-1",
        toolName: "sys_ask_user",
        arguments: { questions: ["继续吗？"] },
        payload: { kind: "ask" },
      }),
    };

    assert.deepEqual(actual, expected);
  });
});
