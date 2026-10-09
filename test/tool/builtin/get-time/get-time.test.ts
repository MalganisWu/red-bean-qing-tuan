import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  DEFAULT_TIMEZONE,
  GetTimeTool,
} from "../../../../src/tool/builtin/get-time/get-time-tool.js";
import { lookupBuiltinTool } from "../../../../src/tool/builtin/catalog.js";
import { FetchUrlTool } from "../../../../src/tool/builtin/fetch-url/fetch-url-tool.js";
import { HttpRequestTool } from "../../../../src/tool/builtin/http-request/http-request-tool.js";
import type { ToolCallContext } from "../../../../src/pipeline/context/runtime-context.js";

const context: ToolCallContext = {
  threadId: "",
  userId: "",
  requestId: "",
  traceId: "",
  callId: "",
  checkpointRevision: 0n,
  fencingToken: 0n,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function execute(
  tool: GetTimeTool,
  params: Record<string, string>,
): Promise<Record<string, unknown>> {
  const result = await tool.execute(
    params,
    context,
    AbortSignal.timeout(1_000),
  );
  const parsed: unknown = JSON.parse(result.content);
  if (!isRecord(parsed)) assert.fail("time result must be an object");
  return parsed;
}

void describe("Runtime TypeScript get-time tool", () => {
  void it("looks up the side-effect-free builtin catalog", () => {
    assert.equal(
      lookupBuiltinTool("sys_get_time") instanceof GetTimeTool,
      true,
    );
    assert.equal(
      lookupBuiltinTool("sys_http_request") instanceof HttpRequestTool,
      true,
    );
    assert.equal(
      lookupBuiltinTool("sys_fetch_url") instanceof FetchUrlTool,
      true,
    );
    assert.equal(lookupBuiltinTool("sys_read_file"), undefined);
    assert.equal(lookupBuiltinTool("unknown"), undefined);
    assert.notEqual(
      lookupBuiltinTool("sys_get_time"),
      lookupBuiltinTool("sys_get_time"),
    );
  });

  void it("uses the default timezone and supports Go-compatible layouts", async () => {
    const fixed = new Date("2026-08-03T09:30:00.000Z");
    const tool = new GetTimeTool((): Date => fixed);
    const defaultResult = await execute(tool, {});
    assert.equal(defaultResult["unix"], fixed.getTime() / 1_000);
    assert.equal(defaultResult["timezone"], DEFAULT_TIMEZONE);
    assert.equal(defaultResult["iso"], "2026-08-03T17:30:00+08:00");

    const customFormat = await execute(tool, { format: "2006-01-02" });
    assert.equal(customFormat["iso"], "2026-08-03");

    const newYork = await execute(tool, { timezone: "America/New_York" });
    assert.equal(newYork["iso"], "2026-08-03T05:30:00-04:00");
    assert.equal(newYork["timezone"], "America/New_York");

    await assert.rejects(
      tool.execute(
        { timezone: "Not/AZone" },
        context,
        AbortSignal.timeout(1_000),
      ),
      /time zone/i,
    );
    await assert.rejects(
      tool.execute({ timezone: 42 }, context, AbortSignal.timeout(1_000)),
      /timezone/i,
    );
  });
});
