import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { LlmChunk, LlmRequest } from "../../../src/llm/model/model.js";
import type { LlmAdapter } from "../../../src/llm/adapter/port/llm-adapter.js";
import {
  CHECKPOINT_STATUSES,
  type Checkpoint,
} from "../../../src/runtime/checkpoint/checkpoint.js";
import {
  AgentRuntime,
  RuntimeExecutionError,
  type RuntimeResult,
  type ToolPolicy,
} from "../../../src/runtime/public-api.js";
import {
  RUN_KINDS,
  type LlmMiddleware,
  type PluginRegistry,
  type RuntimePlugin,
  type ToolMiddleware,
} from "../../../src/runtime/plugin/runtime-plugin.js";
import type { JsonValue } from "../../../src/protocol/json.js";
import type {
  Tool,
  ToolCall,
  ToolCallContext,
  ToolResult,
} from "../../../src/tool/definition/tool.js";
import type { ToolDispatcher } from "../../../src/tool/dispatcher/port/tool-dispatcher.js";

class Deferred {
  public readonly promise: Promise<void>;
  #resolve: () => void = (): void => {};

  public constructor() {
    this.promise = new Promise<void>((resolve): void => {
      this.#resolve = resolve;
    });
  }

  public resolve(): void {
    this.#resolve();
  }
}

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
  #call = 0;

  public streamCompletion(): Promise<AsyncIterable<LlmChunk>> {
    this.#call += 1;
    return Promise.resolve(
      this.#call === 1
        ? stream([
            {
              content: null,
              toolCalls: [
                {
                  id: "call-1",
                  type: "function",
                  function: { name: "echo", arguments: "{}" },
                },
              ],
            },
          ])
        : stream([{ content: "done", finishReason: "stop" }]),
    );
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

void describe("Runtime TypeScript static plugins", () => {
  void it("composes run, LLM, and tool middleware in registration order", async () => {
    const calls: string[] = [];
    const llmMiddleware: LlmMiddleware = {
      wrapLlm: (next: LlmAdapter): LlmAdapter => ({
        streamCompletion: async (
          request: LlmRequest,
          signal: AbortSignal,
        ): Promise<AsyncIterable<LlmChunk>> => {
          calls.push("llm-before");
          const result = await next.streamCompletion(request, signal);
          calls.push("llm-after");
          return result;
        },
      }),
    };
    const toolMiddleware: ToolMiddleware = {
      wrapToolDispatcher: (next: ToolDispatcher): ToolDispatcher => ({
        dispatch: async (
          call: ToolCall,
          context: ToolCallContext,
          signal: AbortSignal,
        ): Promise<ToolResult> => {
          calls.push("tool-before");
          const result = await next.dispatch(call, context, signal);
          calls.push("tool-after");
          return result;
        },
      }),
    };
    const plugin: RuntimePlugin = {
      name: "trace",
      register: (registry: PluginRegistry): void => {
        registry.useRun(async (info, next, signal): Promise<RuntimeResult> => {
          calls.push(`run-before:${info.kind}`);
          const result = await next(signal);
          calls.push(`run-after:${info.kind}`);
          return result;
        });
        registry.useLlm(llmMiddleware);
        registry.useTool(toolMiddleware);
      },
    };
    const runtime = new AgentRuntime({
      model: new SequenceAdapter(),
      tools: [new EchoTool()],
      plugins: [plugin],
    });

    const result = await runtime.run(
      { threadId: "plugin", input: "start" },
      AbortSignal.timeout(1_000),
    );
    assert.equal(result.output, "done");
    assert.deepEqual(calls, [
      `run-before:${RUN_KINDS.RUN}`,
      "llm-before",
      "llm-after",
      "tool-before",
      "tool-after",
      "llm-before",
      "llm-after",
      `run-after:${RUN_KINDS.RUN}`,
    ]);
  });

  void it("keeps tool policy outside plugin middleware", async () => {
    let middlewareCalls = 0;
    const plugin: RuntimePlugin = {
      name: "short-circuit",
      register: (registry: PluginRegistry): void => {
        registry.useTool({
          wrapToolDispatcher: (): ToolDispatcher => ({
            dispatch: (): Promise<ToolResult> => {
              middlewareCalls += 1;
              return Promise.resolve({ content: "bypassed" });
            },
          }),
        });
      },
    };
    const policy: ToolPolicy = {
      authorize: (): Promise<void> => Promise.reject(new Error("blocked")),
    };
    const runtime = new AgentRuntime({
      model: new SequenceAdapter(),
      tools: [new EchoTool()],
      toolPolicy: policy,
      plugins: [plugin],
    });

    assert.equal(
      (
        await runtime.run(
          { threadId: "policy", input: "start" },
          AbortSignal.timeout(1_000),
        )
      ).output,
      "done",
    );
    assert.equal(middlewareCalls, 0);
  });

  void it("wraps both run and resume operations", async () => {
    const kinds: string[] = [];
    const plugin: RuntimePlugin = {
      name: "run-observer",
      register: (registry: PluginRegistry): void => {
        registry.useRun(async (info, next, signal): Promise<RuntimeResult> => {
          kinds.push(info.kind);
          return next(signal);
        });
      },
    };
    const runtime = new AgentRuntime({
      model: {
        streamCompletion: (): Promise<AsyncIterable<LlmChunk>> =>
          Promise.resolve(stream([{ content: "done" }])),
      },
      plugins: [plugin],
    });
    const state: Checkpoint = {
      version: 1,
      threadId: "resume-plugin",
      userId: "",
      status: CHECKPOINT_STATUSES.SUSPENDED,
      messages: [],
      contentRefs: [],
      interrupt: {
        toolCallId: "call-1",
        toolName: "ask",
        arguments: {},
        payload: {},
      },
      lastResumeInterrupt: "",
      tokensUsed: 0,
      finishReason: "",
    };

    await runtime.run({ input: "start" }, AbortSignal.timeout(1_000));
    await runtime.resume(
      {
        state,
        interruptId: "call-1",
        requestId: "resume-1",
        response: "yes",
      },
      AbortSignal.timeout(1_000),
    );
    assert.deepEqual(kinds, [RUN_KINDS.RUN, RUN_KINDS.RESUME]);
  });

  void it("rejects invalid plugins and seals the registry", () => {
    let captured: PluginRegistry | undefined;
    const plugin: RuntimePlugin = {
      name: "capture",
      register: (registry: PluginRegistry): void => {
        captured = registry;
      },
    };
    new AgentRuntime({
      model: new SequenceAdapter(),
      plugins: [plugin],
    });
    assert.ok(captured);
    assert.throws(
      (): void => captured?.useRun((_info, next, signal) => next(signal)),
      /已封存/,
    );
    assert.throws(
      (): AgentRuntime =>
        new AgentRuntime({
          model: new SequenceAdapter(),
          plugins: [plugin, plugin],
        }),
      /插件重复/,
    );
    assert.throws(
      (): AgentRuntime =>
        new AgentRuntime({
          model: new SequenceAdapter(),
          plugins: [
            {
              name: " ",
              register: (): void => {},
            },
          ],
        }),
      /插件的名字不能为空/,
    );
    assert.throws(
      (): AgentRuntime =>
        new AgentRuntime({
          model: new SequenceAdapter(),
          plugins: [
            {
              name: "broken",
              register: (): void => {
                throw new Error("install failed");
              },
            },
          ],
        }),
      /install failed/i,
    );
  });

  void it("waits for active runs and closes resources once in reverse order", async () => {
    const entered = new Deferred();
    const release = new Deferred();
    const model: LlmAdapter = {
      streamCompletion: async (): Promise<AsyncIterable<LlmChunk>> => {
        entered.resolve();
        await release.promise;
        return stream([{ content: "done" }]);
      },
    };
    const closed: string[] = [];
    const plugin = (name: string): RuntimePlugin => ({
      name,
      register: (registry: PluginRegistry): void => {
        registry.onClose((): Promise<void> => {
          closed.push(name);
          return Promise.resolve();
        });
      },
    });
    const runtime = new AgentRuntime({
      model,
      plugins: [plugin("first"), plugin("second")],
    });
    const running = runtime.run(
      { threadId: "close", input: "start" },
      AbortSignal.timeout(1_000),
    );
    await entered.promise;
    const closing = runtime.close(AbortSignal.timeout(1_000));
    const closedEarly = await Promise.race([
      closing.then((): boolean => true),
      new Promise<boolean>((resolve): void => {
        setTimeout((): void => resolve(false), 20);
      }),
    ]);
    assert.equal(closedEarly, false);
    release.resolve();
    await running;
    await closing;
    await runtime.close(AbortSignal.timeout(1_000));
    assert.deepEqual(closed, ["second", "first"]);
    await assert.rejects(
      runtime.run({ input: "after close" }, AbortSignal.timeout(1_000)),
      (error: unknown): boolean => error instanceof RuntimeExecutionError,
    );
  });
});
