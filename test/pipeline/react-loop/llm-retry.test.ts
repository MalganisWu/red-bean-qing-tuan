import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { LLM_ERROR_KINDS, LlmError } from "../../../src/llm/error/llm-error.js";
import {
  llmBackoff,
  resolveLlmRunParams,
  runWithLlmRetry,
} from "../../../src/pipeline/react-loop/llm-retry.js";

void describe("Runtime TypeScript LLM retry policy", () => {
  void it("uses capped exponential backoff", () => {
    assert.deepEqual(
      [0, 1, 2, 3, 4, 5, 6, 10].map((attempt: number): number =>
        llmBackoff(attempt, 2_000, 64_000),
      ),
      [2_000, 4_000, 8_000, 16_000, 32_000, 64_000, 64_000, 64_000],
    );
    assert.equal(llmBackoff(1, 1_000, 3_000), 2_000);
    assert.equal(llmBackoff(2, 1_000, 3_000), 3_000);
  });

  void it("resolves defaults, overrides, and clamps negative retry counts", () => {
    assert.deepEqual(resolveLlmRunParams({}), {
      maxRetries: 10,
      backoffBaseMs: 2_000,
      backoffCapMs: 64_000,
      idleTimeoutMs: 30_000,
    });
    assert.deepEqual(
      resolveLlmRunParams({
        maxLlmRetries: 3,
        llmRetryBackoffSeconds: 1,
        llmRetryBackoffMaxSeconds: 16,
        llmTimeoutSeconds: 60,
      }),
      {
        maxRetries: 3,
        backoffBaseMs: 1_000,
        backoffCapMs: 16_000,
        idleTimeoutMs: 60_000,
      },
    );
    assert.equal(resolveLlmRunParams({ maxLlmRetries: -1 }).maxRetries, 0);
  });

  void it("retries temporary failures until success", async () => {
    let calls = 0;
    const retries: number[] = [];
    const sleeps: number[] = [];
    const result = await runWithLlmRetry(
      resolveLlmRunParams({ maxLlmRetries: 3 }),
      (delayMs: number): Promise<void> => {
        sleeps.push(delayMs);
        return Promise.resolve();
      },
      (attempt: number): void => {
        retries.push(attempt);
      },
      (): Promise<string> => {
        calls += 1;
        return calls < 3
          ? Promise.reject(
              new LlmError(LLM_ERROR_KINDS.TEMPORARY, new Error("429")),
            )
          : Promise.resolve("stream");
      },
      AbortSignal.timeout(1_000),
    );

    assert.equal(result, "stream");
    assert.equal(calls, 3);
    assert.deepEqual(retries, [1, 2]);
    assert.deepEqual(sleeps, [2_000, 4_000]);
  });

  void it("does not retry permanent failures", async () => {
    let calls = 0;
    await assert.rejects(
      runWithLlmRetry(
        resolveLlmRunParams({ maxLlmRetries: 3 }),
        (): Promise<void> => Promise.resolve(),
        (): void => {
          assert.fail("permanent failure must not invoke onRetry");
        },
        (): Promise<string> => {
          calls += 1;
          return Promise.reject(
            new LlmError(LLM_ERROR_KINDS.PERMANENT, new Error("400")),
          );
        },
        AbortSignal.timeout(1_000),
      ),
      /400/,
    );
    assert.equal(calls, 1);
  });

  void it("stops after the configured retry count", async () => {
    let calls = 0;
    let retries = 0;
    await assert.rejects(
      runWithLlmRetry(
        resolveLlmRunParams({ maxLlmRetries: 2 }),
        (): Promise<void> => Promise.resolve(),
        (): void => {
          retries += 1;
        },
        (): Promise<string> => {
          calls += 1;
          return Promise.reject(
            new LlmError(LLM_ERROR_KINDS.TEMPORARY, new Error("429")),
          );
        },
        AbortSignal.timeout(1_000),
      ),
      /429/,
    );
    assert.equal(calls, 3);
    assert.equal(retries, 2);
  });

  void it("stops when cancellation wins during backoff", async () => {
    const controller = new AbortController();
    const stopped = new Error("stopped");
    await assert.rejects(
      runWithLlmRetry(
        resolveLlmRunParams({ maxLlmRetries: 3 }),
        (_delayMs: number, signal: AbortSignal): Promise<void> => {
          controller.abort(stopped);
          const error =
            signal.reason instanceof Error
              ? signal.reason
              : new Error("operation aborted");
          return signal.aborted ? Promise.reject(error) : Promise.resolve();
        },
        (): void => {},
        (): Promise<string> =>
          Promise.reject(
            new LlmError(LLM_ERROR_KINDS.TEMPORARY, new Error("429")),
          ),
        controller.signal,
      ),
      stopped,
    );
  });
});
