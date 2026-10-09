import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  OpenAiAdapter,
  createDefaultLlmAdapterFactory,
  type FetchLike,
} from "../../../src/llm/openai/adapter/openai-compatible-adapter.js";
import {
  LLM_ERROR_KINDS,
  isLlmError,
} from "../../../src/llm/error/llm-error.js";
import type { LlmChunk, LlmRequest } from "../../../src/llm/model/model.js";

const emptyRequest = (): LlmRequest => ({
  messages: [],
  tools: [],
  params: {},
});

function sseResponse(body: string): Response {
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

async function collect(stream: AsyncIterable<LlmChunk>): Promise<LlmChunk[]> {
  const chunks: LlmChunk[] = [];
  for await (const chunk of stream) chunks.push(chunk);
  return chunks;
}

void describe("Runtime TypeScript OpenAI-compatible adapter", () => {
  void it("sends explicit thinking settings and requests stream usage", async () => {
    const bodies: unknown[] = [];
    const fetchImpl: FetchLike = (
      _input: string | URL | Request,
      init?: RequestInit,
    ): Promise<Response> => {
      bodies.push(
        typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
      );
      return Promise.resolve(sseResponse("data: [DONE]\n\n"));
    };
    const adapter = new OpenAiAdapter({
      apiKey: "secret",
      modelName: "model",
      fetch: fetchImpl,
    });

    await collect(
      await adapter.streamCompletion(
        emptyRequest(),
        AbortSignal.timeout(1_000),
      ),
    );
    await collect(
      await adapter.streamCompletion(
        { ...emptyRequest(), params: { thinking: true } },
        AbortSignal.timeout(1_000),
      ),
    );
    await collect(
      await adapter.streamCompletion(
        { ...emptyRequest(), params: { thinking: false } },
        AbortSignal.timeout(1_000),
      ),
    );

    assert.deepEqual(bodies, [
      {
        model: "model",
        messages: [],
        stream: true,
        stream_options: { include_usage: true },
      },
      {
        model: "model",
        messages: [],
        stream: true,
        stream_options: { include_usage: true },
        thinking: { type: "enabled" },
      },
      {
        model: "model",
        messages: [],
        stream: true,
        stream_options: { include_usage: true },
        thinking: { type: "disabled" },
      },
    ]);
  });

  void it("classifies retryable HTTP and network errors", async () => {
    for (const [status, kind] of [
      [429, LLM_ERROR_KINDS.TEMPORARY],
      [500, LLM_ERROR_KINDS.TEMPORARY],
      [400, LLM_ERROR_KINDS.PERMANENT],
      [401, LLM_ERROR_KINDS.PERMANENT],
    ] as const) {
      const adapter = new OpenAiAdapter({
        apiKey: "secret",
        fetch: (): Promise<Response> =>
          Promise.resolve(new Response('{"error":"mock"}', { status })),
      });
      await assert.rejects(
        adapter.streamCompletion(emptyRequest(), AbortSignal.timeout(1_000)),
        (error: unknown): boolean => isLlmError(error, kind),
      );
    }

    const networkAdapter = new OpenAiAdapter({
      apiKey: "secret",
      fetch: (): Promise<Response> =>
        Promise.reject(new Error("connection refused")),
    });
    await assert.rejects(
      networkAdapter.streamCompletion(
        emptyRequest(),
        AbortSignal.timeout(1_000),
      ),
      (error: unknown): boolean => isLlmError(error, LLM_ERROR_KINDS.TEMPORARY),
    );
  });

  void it("parses content, tool deltas, usage, and finish reason", async () => {
    let requestBody = "";
    const adapter = new OpenAiAdapter({
      apiKey: "secret",
      fetch: (
        _input: string | URL | Request,
        init?: RequestInit,
      ): Promise<Response> => {
        requestBody = typeof init?.body === "string" ? init.body : "";
        return Promise.resolve(
          sseResponse(
            'data: {"choices":[{"delta":{"content":"hi","reasoning_content":"think","tool_calls":[{"index":0,"id":"call-1","type":"function","function":{"name":"echo","arguments":"{\\"x\\":"}}]},"finish_reason":null}]}\n\n' +
              'data: {"choices":[{"delta":{"content":"尾"},"finish_reason":"stop"}],"usage":{"prompt_tokens":10,"completion_tokens":5,"total_tokens":15}}\n\n' +
              "data: [DONE]\n\n",
          ),
        );
      },
    });
    const chunks = await collect(
      await adapter.streamCompletion(
        {
          messages: [{ role: "user", content: "hello" }],
          tools: [
            {
              type: "function",
              function: {
                name: "echo",
                description: "echo",
                parameters: {},
              },
              interrupting: true,
            },
          ],
          params: { temperature: 0, maxTokens: 0 },
        },
        AbortSignal.timeout(1_000),
      ),
    );

    assert.equal(chunks[0]?.content, "hi");
    assert.equal(chunks[0]?.reasoningContent, "think");
    assert.equal(chunks[0]?.toolCalls?.[0]?.function.name, "echo");
    assert.deepEqual(chunks[1]?.usage, {
      promptTokens: 10,
      completionTokens: 5,
      totalTokens: 15,
    });
    assert.equal(chunks[2]?.content, "尾");
    assert.equal(chunks[2]?.finishReason, "stop");
    assert.deepEqual(JSON.parse(requestBody), {
      model: "gpt-4",
      messages: [{ role: "user", content: "hello" }],
      stream: true,
      stream_options: { include_usage: true },
      temperature: 0,
      max_tokens: 0,
      tools: [
        {
          type: "function",
          function: {
            name: "echo",
            description: "echo",
            parameters: {},
          },
        },
      ],
    });
  });

  void it("preserves a 200 KB SSE line", async () => {
    const content = "a".repeat(200 * 1024);
    const adapter = new OpenAiAdapter({
      apiKey: "secret",
      fetch: (): Promise<Response> =>
        Promise.resolve(
          sseResponse(
            `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\ndata: [DONE]\n\n`,
          ),
        ),
    });
    const chunks = await collect(
      await adapter.streamCompletion(
        emptyRequest(),
        AbortSignal.timeout(1_000),
      ),
    );
    assert.equal(chunks.map((chunk) => chunk.content ?? "").join(""), content);
  });

  void it("surfaces a provider error after preserving partial content", async () => {
    const adapter = new OpenAiAdapter({
      apiKey: "secret",
      fetch: (): Promise<Response> =>
        Promise.resolve(
          sseResponse(
            'data: {"choices":[{"delta":{"content":"半截"}}]}\n\n' +
              'data: {"error":{"message":"provider overloaded","code":503}}\n\n',
          ),
        ),
    });
    const chunks = await collect(
      await adapter.streamCompletion(
        emptyRequest(),
        AbortSignal.timeout(1_000),
      ),
    );
    assert.equal(chunks[0]?.content, "半截");
    assert.match(chunks[1]?.error?.message ?? "", /provider overloaded/);
    assert.equal(isLlmError(chunks[1]?.error, LLM_ERROR_KINDS.TEMPORARY), true);
  });

  void it("rejects malformed provider fields instead of trusting JSON types", async () => {
    const adapter = new OpenAiAdapter({
      apiKey: "secret",
      fetch: (): Promise<Response> =>
        Promise.resolve(
          sseResponse('data: {"choices":[{"delta":{"content":42}}]}\n\n'),
        ),
    });
    const chunks = await collect(
      await adapter.streamCompletion(
        emptyRequest(),
        AbortSignal.timeout(1_000),
      ),
    );
    assert.equal(chunks.length, 1);
    assert.equal(isLlmError(chunks[0]?.error, LLM_ERROR_KINDS.PERMANENT), true);
  });

  void it("stops a blocked stream reader when the request is cancelled", async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller): void {
        controller.enqueue(
          new TextEncoder().encode(
            'data: {"choices":[{"delta":{"content":"first"}}]}\n\n',
          ),
        );
      },
    });
    const adapter = new OpenAiAdapter({
      apiKey: "secret",
      fetch: (): Promise<Response> => Promise.resolve(new Response(body)),
    });
    const controller = new AbortController();
    const iterator = (
      await adapter.streamCompletion(emptyRequest(), controller.signal)
    )[Symbol.asyncIterator]();
    const first = await iterator.next();
    assert.equal(first.done, false);
    if (first.done) assert.fail("stream ended before the first chunk");
    assert.equal(first.value.content, "first");
    const blocked = iterator.next();
    controller.abort(new Error("client left"));
    await assert.rejects(blocked, /client left/);
  });

  void it("provides a default factory without hidden request timeouts", () => {
    const factory = createDefaultLlmAdapterFactory();
    assert.equal(
      factory("openai", "key", "", "") instanceof OpenAiAdapter,
      true,
    );
    assert.throws(
      (): unknown => factory("anthropic", "key", "", ""),
      /provider/i,
    );
  });
});
