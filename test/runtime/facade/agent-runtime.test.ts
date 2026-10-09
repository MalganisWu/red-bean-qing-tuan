import assert from "node:assert/strict";
import { describe, it } from "node:test";

// Runtime Facade 行为测试与 src/runtime 能力目录保持镜像。

import type { LlmChunk, LlmRequest } from "../../../src/llm/model/model.js";
import type { LlmAdapter } from "../../../src/llm/adapter/port/llm-adapter.js";
import {
  CHECKPOINT_STATUSES,
  MemoryCheckpointStore,
} from "../../../src/runtime/checkpoint/checkpoint.js";
import {
  AgentRuntime,
  RuntimeExecutionError,
  type ToolPolicy,
} from "../../../src/runtime/public-api.js";
import { createInterruptSignal } from "../../../src/pipeline/interrupt/interrupt-factory.js";
import type { InterruptAssembler } from "../../../src/pipeline/interrupt/port/interrupt-assembler.js";
import type { Interrupt } from "../../../src/protocol/interrupt.js";
import type { RuntimeContext } from "../../../src/pipeline/context/runtime-context.js";
import type { MessageHook } from "../../../src/pipeline/hook/port/message-hook.js";
import type { RawMessage } from "../../../src/protocol/message.js";
import type { JsonValue } from "../../../src/protocol/json.js";
import type {
  Tool,
  ToolCall,
  ToolCallContext,
  ToolResult,
} from "../../../src/tool/definition/tool.js";

function stream(chunks: readonly LlmChunk[]): AsyncIterable<LlmChunk> {
  return {
    [Symbol.asyncIterator](): AsyncIterator<LlmChunk> {
      let index = 0;
      return {
        next(): Promise<IteratorResult<LlmChunk>> {
          const chunk = chunks[index];
          index += 1;
          return chunk
            ? Promise.resolve({ done: false, value: chunk })
            : Promise.resolve({ done: true, value: undefined });
        },
      };
    },
  };
}

class SequenceAdapter implements LlmAdapter {
  public readonly requests: LlmRequest[] = [];
  readonly #responses: readonly (readonly LlmChunk[])[];
  #index = 0;

  public constructor(responses: readonly (readonly LlmChunk[])[]) {
    this.#responses = responses;
  }

  public streamCompletion(
    request: LlmRequest,
    _signal: AbortSignal,
  ): Promise<AsyncIterable<LlmChunk>> {
    this.requests.push(request);
    const response = this.#responses[this.#index] ?? [];
    this.#index += 1;
    return Promise.resolve(stream(response));
  }
}

class AskTool implements Tool {
  public readonly name = "ask";
  public readonly schema = {
    type: "function",
    function: { name: "ask", description: "", parameters: {} },
    interrupting: true,
  };

  public execute(): Promise<ToolResult> {
    return Promise.resolve({
      content: "",
      signal: createInterruptSignal({ question: "continue?" }),
    });
  }
}

class EchoTool implements Tool {
  public readonly name = "echo";
  public readonly schema = {
    type: "function",
    function: { name: "echo", description: "", parameters: {} },
  };

  public execute(
    _params: JsonValue,
    _context: ToolCallContext,
    _signal: AbortSignal,
  ): Promise<ToolResult> {
    return Promise.resolve({ content: "ok" });
  }
}

function call(name: string, id: string): LlmChunk {
  return {
    content: null,
    toolCalls: [
      {
        id,
        type: "function",
        function: { name, arguments: "{}" },
      },
    ],
  };
}

void describe("Runtime TypeScript high-level facade", () => {
  void it("runs, checkpoints an interrupt, and resumes with the stored response", async () => {
    const adapter = new SequenceAdapter([
      [call("ask", "call-1")],
      [{ content: "done", finishReason: "stop" }],
    ]);
    const store = new MemoryCheckpointStore();
    const runtime = new AgentRuntime({
      model: adapter,
      tools: [new AskTool()],
      checkpointStore: store,
    });

    const first = await runtime.run(
      { threadId: "thread-1", input: "start" },
      AbortSignal.timeout(1_000),
    );
    assert.equal(first.status, CHECKPOINT_STATUSES.SUSPENDED);
    assert.equal(first.interrupt?.toolCallId, "call-1");
    assert.equal(first.revision, 1n);

    const resumed = await runtime.resume(
      {
        threadId: "thread-1",
        requestId: "resume-1",
        interruptId: "call-1",
        response: "yes",
      },
      AbortSignal.timeout(1_000),
    );
    assert.equal(resumed.status, CHECKPOINT_STATUSES.COMPLETED);
    assert.equal(resumed.output, "done");
    assert.equal(resumed.revision, 3n);
    assert.deepEqual(adapter.requests.at(-1)?.messages.at(-1), {
      role: "tool",
      content: "yes",
      toolCallId: "call-1",
    });
  });

  void it("exposes neutral message and interrupt lifecycle callbacks", async () => {
    const messages: RawMessage[] = [];
    const interrupts: Interrupt[] = [];
    const hook: MessageHook = {
      onUserMessage: (_context, message): Promise<void> => {
        messages.push(message);
        return Promise.resolve();
      },
      onAssistantMessage: (_context, message): Promise<void> => {
        messages.push(message);
        return Promise.resolve();
      },
      onToolMessage: (_context, message): Promise<void> => {
        messages.push(message);
        return Promise.resolve();
      },
    };
    const assembler: InterruptAssembler = {
      assemble: (
        _context: RuntimeContext,
        interrupt: Interrupt,
      ): Promise<void> => {
        interrupts.push(interrupt);
        return Promise.resolve();
      },
    };
    const runtime = new AgentRuntime({
      model: new SequenceAdapter([[call("ask", "call-observed")]]),
      tools: [new AskTool()],
      messageHook: hook,
      interruptAssembler: assembler,
    });

    const result = await runtime.run(
      { input: "start" },
      AbortSignal.timeout(1_000),
    );

    assert.equal(result.status, CHECKPOINT_STATUSES.SUSPENDED);
    assert.deepEqual(
      messages.map((message) => message.role),
      ["user", "assistant"],
    );
    assert.equal(interrupts[0]?.toolCallId, "call-observed");
  });

  void it("reports iteration exhaustion as a domain result", async () => {
    const runtime = new AgentRuntime({
      model: new SequenceAdapter([[call("echo", "call-1")]]),
      tools: [new EchoTool()],
      runtimeConfig: { maxToolIterations: 1 },
    });

    const result = await runtime.run(
      { input: "start" },
      AbortSignal.timeout(1_000),
    );
    assert.equal(result.status, CHECKPOINT_STATUSES.EXHAUSTED);
  });

  void it("validates tool names during construction", () => {
    const mismatched: Tool = {
      name: "different",
      schema: {
        type: "function",
        function: { name: "echo", description: "", parameters: {} },
      },
      execute: (): Promise<ToolResult> => Promise.resolve({ content: "" }),
    };
    assert.throws(
      (): AgentRuntime =>
        new AgentRuntime({
          model: new SequenceAdapter([]),
          tools: [mismatched],
        }),
      /does not match schema/i,
    );
  });

  void it("returns a cancelled diagnostic result when aborted before the model", async () => {
    const runtime = new AgentRuntime({ model: new SequenceAdapter([]) });
    await assert.rejects(
      runtime.run(
        { threadId: "cancelled", input: "start" },
        AbortSignal.abort(new Error("cancelled")),
      ),
      (error: unknown): boolean => {
        assert.equal(error instanceof RuntimeExecutionError, true);
        if (!(error instanceof RuntimeExecutionError)) return false;
        assert.equal(error.result.status, CHECKPOINT_STATUSES.CANCELLED);
        assert.equal(error.result.checkpoint.messages[0]?.content, "start");
        return true;
      },
    );
  });

  void it("feeds a tool policy denial back to the model", async () => {
    const policy: ToolPolicy = {
      authorize: (
        _call: ToolCall,
        _context: ToolCallContext,
        _signal: AbortSignal,
      ): Promise<void> => Promise.reject(new Error("not allowed")),
    };
    const adapter = new SequenceAdapter([
      [call("echo", "call-1")],
      [{ content: "handled denial" }],
    ]);
    const runtime = new AgentRuntime({
      model: adapter,
      tools: [new EchoTool()],
      toolPolicy: policy,
    });

    const result = await runtime.run(
      { input: "start" },
      AbortSignal.timeout(1_000),
    );
    assert.equal(result.output, "handled denial");
    assert.match(
      adapter.requests[1]?.messages.at(-1)?.content ?? "",
      /not allowed/i,
    );
  });
});
