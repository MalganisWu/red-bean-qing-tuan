import assert from "node:assert/strict";
import { describe, it } from "node:test";

// runWithMiddleware 的洋葱语义单测。
// 集成测试（runtime-plugin.test.ts）覆盖的是「经过 AgentRuntime 后的完整顺序」，
// 这里直接盯编排函数本身：层与层之间的跳转、短路、以及取消信号的传递。

import { CHECKPOINT_STATUSES } from "../../../src/runtime/checkpoint/checkpoint.js";
import type { Checkpoint } from "../../../src/runtime/checkpoint/model/checkpoint.js";
import {
  RUN_KINDS,
  runWithMiddleware,
  type RunHandler,
  type RunInfo,
  type RunMiddleware,
} from "../../../src/runtime/plugin/runtime-plugin.js";
import type { RuntimeResult } from "../../../src/runtime/run/result/runtime-result.js";

const RUN_INFO: RunInfo = {
  kind: RUN_KINDS.RUN,
  threadId: "thread-middleware",
  userId: "user-middleware",
  requestId: "request-middleware",
  traceId: "trace-middleware",
};

function checkpointFor(): Checkpoint {
  return {
    version: 1,
    threadId: RUN_INFO.threadId,
    userId: RUN_INFO.userId,
    status: CHECKPOINT_STATUSES.COMPLETED,
    messages: [{ role: "assistant", content: "done" }],
    contentRefs: [],
    lastResumeInterrupt: "",
    tokensUsed: 0,
    finishReason: "stop",
  };
}

function resultFor(output: string): RuntimeResult {
  return {
    status: CHECKPOINT_STATUSES.COMPLETED,
    output,
    messages: [{ role: "assistant", content: output }],
    tokensUsed: 0,
    finishReason: "stop",
    checkpoint: checkpointFor(),
    revision: 0n,
  };
}

/** 最终处理器：记录一次调用后返回固定输出。不需要 await，因此不写成 async 函数。 */
function finalHandlerFor(calls: string[], output: string): RunHandler {
  return (): Promise<RuntimeResult> => {
    calls.push("final");
    return Promise.resolve(resultFor(output));
  };
}

/** 记录进出顺序的中间件；`passthrough: false` 表示不调用下一跳（短路）。 */
function tracingMiddleware(
  label: string,
  calls: string[],
  passthrough = true,
): RunMiddleware {
  return async (_info, next, signal): Promise<RuntimeResult> => {
    calls.push(`${label}:before`);
    if (!passthrough) return resultFor(`${label}-short-circuit`);
    const result = await next(signal);
    calls.push(`${label}:after`);
    return result;
  };
}

void describe("Runtime TypeScript run middleware composition", () => {
  void it("enters layers in registration order and leaves in reverse", async () => {
    const calls: string[] = [];
    const result = await runWithMiddleware(
      RUN_INFO,
      [
        tracingMiddleware("outer", calls),
        tracingMiddleware("middle", calls),
        tracingMiddleware("inner", calls),
      ],
      finalHandlerFor(calls, "final"),
      AbortSignal.timeout(1_000),
    );

    assert.equal(result.output, "final");
    assert.deepEqual(calls, [
      "outer:before",
      "middle:before",
      "inner:before",
      "final",
      "inner:after",
      "middle:after",
      "outer:after",
    ]);
  });

  void it("stops at a layer that does not call next", async () => {
    const calls: string[] = [];
    const result = await runWithMiddleware(
      RUN_INFO,
      [
        tracingMiddleware("outer", calls),
        tracingMiddleware("blocking", calls, false),
        tracingMiddleware("unreachable", calls),
      ],
      finalHandlerFor(calls, "final"),
      AbortSignal.timeout(1_000),
    );

    assert.equal(result.output, "blocking-short-circuit");
    assert.deepEqual(calls, ["outer:before", "blocking:before", "outer:after"]);
  });

  void it("hands each layer the signal its caller passed down", async () => {
    const seen: AbortSignal[] = [];
    const outer = new AbortController();
    const narrower = new AbortController();
    // 中间层把取消信号换成自己的作用域信号；内层应当看到换过的那一个。
    const replacing: RunMiddleware = async (
      _info,
      next,
    ): Promise<RuntimeResult> => {
      return await next(narrower.signal);
    };
    const recording: RunMiddleware = async (
      _info,
      next,
      signal,
    ): Promise<RuntimeResult> => {
      seen.push(signal);
      return await next(signal);
    };

    await runWithMiddleware(
      RUN_INFO,
      [recording, replacing, recording],
      (signal): Promise<RuntimeResult> => {
        seen.push(signal);
        return Promise.resolve(resultFor("final"));
      },
      outer.signal,
    );

    assert.equal(seen.length, 3);
    assert.equal(seen[0], outer.signal, "最外层拿到调用方传入的信号");
    assert.equal(seen[1], narrower.signal, "内层拿到中间层替换后的信号");
    assert.equal(seen[2], narrower.signal, "最终处理器拿到被替换后的信号");
  });

  void it("runs the final handler directly when no middleware is registered", async () => {
    const result = await runWithMiddleware(
      RUN_INFO,
      [],
      (): Promise<RuntimeResult> => Promise.resolve(resultFor("bare")),
      AbortSignal.timeout(1_000),
    );
    assert.equal(result.output, "bare");
  });
});
