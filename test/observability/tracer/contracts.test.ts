import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  NoopSpan,
  NoopTracer,
} from "../../../src/observability/tracer/adapter/noop-tracer.js";
import type { SpanStart } from "../../../src/observability/tracer/port/tracer.js";

void describe("Runtime TypeScript observability contracts", () => {
  void it("keeps the tracer backend-neutral and supplies a no-op implementation", async () => {
    const tracer = new NoopTracer();
    const start: SpanStart = {
      name: "agent.run",
      attributes: [{ key: "agent.id", value: "assistant" }],
    };
    const span = tracer.start(start);

    assert.equal(span instanceof NoopSpan, true);
    span.setAttributes({ key: "run.status", value: "completed" });
    assert.equal(
      await span.within((): Promise<string> => Promise.resolve("ok")),
      "ok",
    );
    span.end();
  });
});
