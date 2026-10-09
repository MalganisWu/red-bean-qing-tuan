import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { assembleToolCalls } from "../../../src/pipeline/react-loop/tool-call-buffer.js";

void describe("Runtime TypeScript tool-call buffering", () => {
  void it("preserves sparse provider indexes in ascending order", () => {
    const calls = assembleToolCalls(
      new Map([
        [
          3,
          {
            id: "call-3",
            nameParts: ["tool", "_three"],
            argumentParts: ["{", "}"],
          },
        ],
        [
          1,
          {
            id: "call-1",
            nameParts: ["tool_one"],
            argumentParts: ['{"x":', "1}"],
          },
        ],
      ]),
    );

    assert.deepEqual(calls, [
      {
        index: 1,
        id: "call-1",
        type: "function",
        function: { name: "tool_one", arguments: '{"x":1}' },
      },
      {
        index: 3,
        id: "call-3",
        type: "function",
        function: { name: "tool_three", arguments: "{}" },
      },
    ]);
  });
});
