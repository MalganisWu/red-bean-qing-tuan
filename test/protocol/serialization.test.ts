import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { ContentRef } from "../../src/protocol/content-reference.js";
import { serializeContentRef } from "../../src/protocol/content-reference.js";
import { serializeRawMessage } from "../../src/protocol/message.js";
import { serializeModelParams } from "../../src/llm/codec/model-params-serializer.js";

void describe("Runtime TypeScript serialization contracts", () => {
  void it("preserves the OpenAI message shape and omits empty optional fields", () => {
    const payload = serializeRawMessage({
      role: "assistant",
      content: null,
      toolCalls: [
        {
          index: 0,
          id: "call_1",
          type: "function",
          function: { name: "sys_get_time", arguments: "{}" },
        },
      ],
      toolCallId: "",
      name: "",
    });

    assert.deepEqual(payload, {
      role: "assistant",
      content: null,
      tool_calls: [
        {
          id: "call_1",
          type: "function",
          function: { name: "sys_get_time", arguments: "{}" },
        },
      ],
    });
  });

  void it("keeps content references serializable and excludes the in-process fetcher", () => {
    const reference: ContentRef = {
      kind: "object",
      key: "docs/1",
      version: "v2",
      meta: { bucket: "agent" },
      fetch: () => Promise.resolve(new TextEncoder().encode("in-process")),
    };

    const payload = serializeContentRef(reference);

    assert.deepEqual(payload, {
      kind: "object",
      key: "docs/1",
      version: "v2",
      meta: { bucket: "agent" },
    });
    assert.equal("fetch" in payload, false);
  });

  void it("serializes explicit zero and false model settings while omitting absent settings", () => {
    assert.deepEqual(
      serializeModelParams({ temperature: 0, maxTokens: 0, thinking: false }),
      {
        temperature: 0,
        max_tokens: 0,
        thinking: false,
      },
    );
  });
});
