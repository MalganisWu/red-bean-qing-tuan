import type { LlmChunk, LlmRequest } from "../../../src/llm/model/model.js";
import type { LlmAdapter } from "../../../src/llm/adapter/port/llm-adapter.js";
import {
  CHECKPOINT_STATUSES,
  type Checkpoint,
  type CheckpointRecord,
  type CheckpointStore,
  type ConsumeInterruptRequest,
  type ConsumeInterruptResult,
  type DeleteCheckpointRequest,
  type LoadCheckpointRequest,
  type SaveCheckpointRequest,
} from "../../../src/runtime/checkpoint/checkpoint.js";
import {
  RUNTIME_ERROR_CODES,
  RuntimeError,
  type RuntimeErrorCode,
} from "../../../src/runtime/run/error/runtime-error.js";
import { createInterruptSignal } from "../../../src/pipeline/interrupt/interrupt-factory.js";
import type {
  Tool,
  ToolCall,
  ToolCallContext,
  ToolResult,
} from "../../../src/tool/definition/tool.js";
import type { ToolDispatcher } from "../../../src/tool/dispatcher/port/tool-dispatcher.js";
export class Deferred {
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

export function stream(chunks: readonly LlmChunk[]): AsyncIterable<LlmChunk> {
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

export function toolCall(name: string, id: string): LlmChunk {
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

export class SequenceAdapter implements LlmAdapter {
  public readonly requests: LlmRequest[] = [];
  readonly #responses: readonly (readonly LlmChunk[])[];
  #index = 0;

  public constructor(responses: readonly (readonly LlmChunk[])[]) {
    this.#responses = responses;
  }

  public streamCompletion(
    request: LlmRequest,
  ): Promise<AsyncIterable<LlmChunk>> {
    this.requests.push(request);
    const response = this.#responses[this.#index] ?? [];
    this.#index += 1;
    return Promise.resolve(stream(response));
  }
}

export class AskTool implements Tool {
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

export class BlockingAdapter implements LlmAdapter {
  public active = 0;
  public maxActive = 0;
  public calls = 0;
  public readonly entered: readonly [Deferred, Deferred] = [
    new Deferred(),
    new Deferred(),
  ];
  public readonly releases: readonly [Deferred, Deferred] = [
    new Deferred(),
    new Deferred(),
  ];

  public async streamCompletion(): Promise<AsyncIterable<LlmChunk>> {
    const index = this.calls;
    this.calls += 1;
    this.active += 1;
    this.maxActive = Math.max(this.maxActive, this.active);
    this.entered[index]?.resolve();
    await this.releases[index]?.promise;
    this.active -= 1;
    return stream([{ content: "done", finishReason: "stop" }]);
  }
}

export class ResumableBlockingAdapter implements LlmAdapter {
  public resumeCalls = 0;
  public readonly resumeEntered = new Deferred();
  public readonly resumeRelease = new Deferred();

  public async streamCompletion(
    request: LlmRequest,
    signal: AbortSignal,
  ): Promise<AsyncIterable<LlmChunk>> {
    if (request.messages.at(-1)?.role === "user") {
      return stream([toolCall("ask", "call-once")]);
    }
    this.resumeCalls += 1;
    this.resumeEntered.resolve();
    await Promise.race([
      this.resumeRelease.promise,
      new Promise<never>((_resolve, reject): void => {
        signal.addEventListener(
          "abort",
          (): void =>
            reject(
              signal.reason instanceof Error
                ? signal.reason
                : new Error("aborted"),
            ),
          { once: true },
        );
      }),
    ]);
    return stream([{ content: "resumed once", finishReason: "stop" }]);
  }
}

export class ProbeDispatcher implements ToolDispatcher {
  public context: ToolCallContext | undefined;

  public dispatch(
    _call: ToolCall,
    context: ToolCallContext,
    _signal: AbortSignal,
  ): Promise<ToolResult> {
    this.context = context;
    return Promise.resolve({ content: "ok" });
  }
}

export class DelegatingStore implements CheckpointStore {
  protected readonly next: CheckpointStore;

  public constructor(next: CheckpointStore) {
    this.next = next;
  }

  public load(
    request: LoadCheckpointRequest,
    signal: AbortSignal,
  ): Promise<CheckpointRecord> {
    return this.next.load(request, signal);
  }

  public save(
    request: SaveCheckpointRequest,
    signal: AbortSignal,
  ): Promise<CheckpointRecord> {
    return this.next.save(request, signal);
  }

  public consumeInterrupt(
    request: ConsumeInterruptRequest,
    signal: AbortSignal,
  ): Promise<ConsumeInterruptResult> {
    return this.next.consumeInterrupt(request, signal);
  }

  public delete(
    request: DeleteCheckpointRequest,
    signal: AbortSignal,
  ): Promise<bigint> {
    return this.next.delete(request, signal);
  }
}

export class CanonicalResponseStore extends DelegatingStore {
  public override consumeInterrupt(
    request: ConsumeInterruptRequest,
    signal: AbortSignal,
  ): Promise<ConsumeInterruptResult> {
    return this.next.consumeInterrupt(
      { ...request, response: "stored" },
      signal,
    );
  }
}

export class FailingSaveStore extends DelegatingStore {
  public override save(): Promise<CheckpointRecord> {
    return Promise.reject(new Error("save unavailable"));
  }
}

export class NonFencingStore extends DelegatingStore {
  public override load(
    request: LoadCheckpointRequest,
    signal: AbortSignal,
  ): Promise<CheckpointRecord> {
    if (request.fencingToken !== 0n) {
      return Promise.reject(
        new RuntimeError(RUNTIME_ERROR_CODES.FENCING_UNSUPPORTED),
      );
    }
    return super.load(request, signal);
  }

  public override save(
    request: SaveCheckpointRequest,
    signal: AbortSignal,
  ): Promise<CheckpointRecord> {
    if (request.fencingToken !== 0n) {
      return Promise.reject(
        new RuntimeError(RUNTIME_ERROR_CODES.FENCING_UNSUPPORTED),
      );
    }
    return super.save(request, signal);
  }

  public override consumeInterrupt(
    request: ConsumeInterruptRequest,
    signal: AbortSignal,
  ): Promise<ConsumeInterruptResult> {
    if (request.fencingToken !== 0n) {
      return Promise.reject(
        new RuntimeError(RUNTIME_ERROR_CODES.FENCING_UNSUPPORTED),
      );
    }
    return super.consumeInterrupt(request, signal);
  }

  public override delete(
    request: DeleteCheckpointRequest,
    signal: AbortSignal,
  ): Promise<bigint> {
    if (request.fencingToken !== 0n) {
      return Promise.reject(
        new RuntimeError(RUNTIME_ERROR_CODES.FENCING_UNSUPPORTED),
      );
    }
    return super.delete(request, signal);
  }
}

export class FailingResumeAdapter implements LlmAdapter {
  public calls = 0;

  public streamCompletion(): Promise<AsyncIterable<LlmChunk>> {
    this.calls += 1;
    if (this.calls === 1) {
      return Promise.resolve(stream([toolCall("ask", "call-failure")]));
    }
    return Promise.reject(new Error("model unavailable"));
  }
}

export function hasRuntimeCode(
  value: unknown,
  code: RuntimeErrorCode,
): boolean {
  let current: unknown = value;
  const seen = new Set<unknown>();
  while (current instanceof Error && !seen.has(current)) {
    const cause: unknown = current.cause;
    if (current instanceof RuntimeError && current.code === code) return true;
    seen.add(current);
    current = cause;
  }
  return false;
}

export function suspendedState(
  threadId: string,
  interruptId: string,
): Checkpoint {
  return {
    version: 1,
    threadId,
    userId: "owner",
    status: CHECKPOINT_STATUSES.SUSPENDED,
    messages: [],
    contentRefs: [],
    interrupt: {
      toolCallId: interruptId,
      toolName: "ask",
      arguments: {},
      payload: {},
    },
    lastResumeInterrupt: "",
    tokensUsed: 0,
    finishReason: "",
  };
}

export const activeSignal = (): AbortSignal => AbortSignal.timeout(2_000);
