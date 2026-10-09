import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  isRuntimeError,
  RuntimeError,
  RUNTIME_ERROR_CODES,
} from "../../../src/runtime/run/error/runtime-error.js";
import {
  classifyLlmError,
  isLlmError,
  LLM_ERROR_KINDS,
} from "../../../src/llm/error/llm-error.js";
import {
  HookFatalError,
  isHookFatalError,
} from "../../../src/pipeline/hook/hook-error.js";

void describe("Runtime TypeScript error contracts", () => {
  void it("uses stable Runtime error codes and preserves causes", () => {
    const cause = new Error("database unavailable");
    const error = new RuntimeError(RUNTIME_ERROR_CODES.REVISION_CONFLICT, {
      cause,
    });

    assert.equal(error.code, "checkpoint_revision_conflict");
    assert.equal(error.message, "checkpoint revision conflict");
    assert.equal(error.cause, cause);
    assert.equal(isRuntimeError(error), true);
    assert.equal(
      isRuntimeError(error, RUNTIME_ERROR_CODES.REVISION_CONFLICT),
      true,
    );
    assert.equal(isRuntimeError(error, RUNTIME_ERROR_CODES.STALE_FENCE), false);
  });

  void it("classifies temporary and permanent LLM failures without losing the cause", () => {
    const cause = new Error("provider overloaded");
    const temporary = classifyLlmError(LLM_ERROR_KINDS.TEMPORARY, cause);

    assert.ok(temporary);
    assert.equal(temporary.message, cause.message);
    assert.equal(temporary.cause, cause);
    assert.equal(isLlmError(temporary, LLM_ERROR_KINDS.TEMPORARY), true);
    assert.equal(isLlmError(temporary, LLM_ERROR_KINDS.PERMANENT), false);
    assert.equal(
      classifyLlmError(LLM_ERROR_KINDS.PERMANENT, undefined),
      undefined,
    );
  });

  void it("marks fatal hook failures explicitly", () => {
    const cause = new Error("display persistence failed");
    const error = new HookFatalError(cause);

    assert.equal(
      error.message,
      `hook fatal error, abort pipeline: ${cause.message}`,
    );
    assert.equal(error.cause, cause);
    assert.equal(isHookFatalError(error), true);
    assert.equal(isHookFatalError(cause), false);
  });
});
