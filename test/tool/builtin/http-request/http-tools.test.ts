import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { ToolCallContext } from "../../../../src/pipeline/context/runtime-context.js";
import {
  FetchUrlTool,
  MAX_FETCH_BODY_BYTES,
  MAX_FETCH_OUTPUT_BYTES,
} from "../../../../src/tool/builtin/fetch-url/fetch-url-tool.js";
import type {
  HttpClient,
  HttpClientRequest,
  HttpClientResponse,
} from "../../../../src/tool/builtin/http-request/http-client.js";
import { HttpRequestTool } from "../../../../src/tool/builtin/http-request/http-request-tool.js";

const context: ToolCallContext = {
  threadId: "",
  userId: "",
  requestId: "",
  traceId: "",
  callId: "",
  checkpointRevision: 0n,
  fencingToken: 0n,
};

interface FakeRoute {
  readonly statusCode?: number;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: string;
  readonly truncated?: boolean;
  readonly error?: Error;
}

class FakeHttpClient implements HttpClient {
  public readonly requests: HttpClientRequest[] = [];
  readonly #routes: Readonly<Record<string, FakeRoute>>;

  public constructor(routes: Readonly<Record<string, FakeRoute>>) {
    this.#routes = routes;
  }

  public request(
    request: HttpClientRequest,
    _signal: AbortSignal,
  ): Promise<HttpClientResponse> {
    this.requests.push(request);
    const route = this.#routes[request.url.href];
    if (route?.error) return Promise.reject(route.error);
    if (route === undefined)
      return Promise.reject(new Error("missing fake route"));
    return Promise.resolve({
      statusCode: route.statusCode ?? 200,
      headers: route.headers ?? {},
      body: new TextEncoder().encode(route.body ?? ""),
      truncated: route.truncated ?? false,
    });
  }
}

function parseObject(content: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(content);
  if (!isRecord(parsed)) {
    assert.fail("expected a JSON object");
  }
  return parsed;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function fetchResult(
  tool: FetchUrlTool,
  url: string,
): Promise<Record<string, unknown>> {
  const result = await tool.execute(
    { url },
    context,
    AbortSignal.timeout(1_000),
  );
  return parseObject(result.content);
}

void describe("Runtime TypeScript HTTP request tool", () => {
  void it("forwards method, headers, and body and bounds the raw response", async () => {
    const client = new FakeHttpClient({
      "https://api.example/items": {
        statusCode: 201,
        body: "created",
      },
    });
    const result = parseObject(
      (
        await new HttpRequestTool(client).execute(
          {
            method: "post",
            url: "https://api.example/items",
            headers: { authorization: "Bearer token" },
            body: "{}",
          },
          context,
          AbortSignal.timeout(1_000),
        )
      ).content,
    );
    assert.deepEqual(result, { status_code: 201, body: "created" });
    assert.equal(client.requests[0]?.method, "POST");
    assert.equal(client.requests[0]?.headers["authorization"], "Bearer token");
    assert.equal(client.requests[0]?.body, "{}");
    assert.equal(client.requests[0]?.maxResponseBytes, 1_048_576);
  });

  void it("validates all external parameter fields", async () => {
    const tool = new HttpRequestTool(new FakeHttpClient({}));
    for (const params of [
      {},
      { method: "GET", url: 42 },
      { method: "TRACE", url: "https://example.com" },
      { method: "GET", url: "file:///etc/passwd" },
      {
        method: "GET",
        url: "https://example.com",
        headers: { broken: 1 },
      },
    ]) {
      await assert.rejects(
        tool.execute(params, context, AbortSignal.timeout(1_000)),
      );
    }
  });
});

void describe("Runtime TypeScript fetch-url tool", () => {
  void it("extracts readable HTML, title, and entities without scripts or styles", async () => {
    const url = "https://example.com/page";
    const client = new FakeHttpClient({
      [url]: {
        headers: { "content-type": "text/html; charset=utf-8" },
        body: "<html><head><title>示例标题</title><script>secret()</script><style>.x{color:red}</style></head><body><h1>一级标题</h1><p>a &amp; b</p></body></html>",
      },
    });
    const result = await fetchResult(new FetchUrlTool({ client }), url);
    assert.equal(result["title"], "示例标题");
    assert.match(String(result["content"]), /一级标题/);
    assert.match(String(result["content"]), /a & b/);
    assert.doesNotMatch(String(result["content"]), /secret|color|</);
    assert.equal(result["truncated"], false);
    assert.equal(result["url"], url);
  });

  void it("returns non-HTML and empty bodies without transformation", async () => {
    const jsonUrl = "https://example.com/data";
    const emptyUrl = "https://example.com/empty";
    const client = new FakeHttpClient({
      [jsonUrl]: {
        headers: { "content-type": "application/json" },
        body: '{"key":"value"}',
      },
      [emptyUrl]: {
        headers: { "content-type": "text/html" },
        body: "",
      },
    });
    assert.equal(
      (await fetchResult(new FetchUrlTool({ client }), jsonUrl))["content"],
      '{"key":"value"}',
    );
    assert.equal(
      (await fetchResult(new FetchUrlTool({ client }), emptyUrl))["content"],
      "",
    );
  });

  void it("validates URLs and reports HTTP and connection errors", async () => {
    const statusUrl = "https://example.com/missing";
    const failureUrl = "https://example.com/failure";
    const tool = new FetchUrlTool({
      client: new FakeHttpClient({
        [statusUrl]: { statusCode: 404 },
        [failureUrl]: { error: new Error("internal topology") },
      }),
    });
    for (const url of ["", "file:///etc/passwd", "ftp://example.com/x"]) {
      await assert.rejects(
        tool.execute({ url }, context, AbortSignal.timeout(1_000)),
      );
    }
    await assert.rejects(fetchResult(tool, statusUrl), /404/);
    await assert.rejects(fetchResult(tool, failureUrl), /无法连接目标主机/);
  });

  void it("truncates oversized raw and HTML output on UTF-8 boundaries", async () => {
    const rawUrl = "https://example.com/raw";
    const htmlUrl = "https://example.com/html";
    const client = new FakeHttpClient({
      [rawUrl]: {
        headers: { "content-type": "text/plain" },
        body: "a".repeat(MAX_FETCH_BODY_BYTES),
        truncated: true,
      },
      [htmlUrl]: {
        headers: { "content-type": "text/html" },
        body: `<p>${"这是很长的正文。".repeat(10_000)}</p>`,
      },
    });
    for (const url of [rawUrl, htmlUrl]) {
      const result = await fetchResult(new FetchUrlTool({ client }), url);
      assert.equal(result["truncated"], true);
      assert.ok(
        Buffer.byteLength(String(result["content"]), "utf8") <=
          MAX_FETCH_OUTPUT_BYTES,
      );
      assert.doesNotMatch(String(result["content"]), /�/);
    }
  });

  void it("follows redirects and validates every location and redirect limit", async () => {
    const start = "https://example.com/start";
    const final = "https://example.com/final";
    const loop = "https://example.com/loop";
    const missing = "https://example.com/missing-location";
    const invalid = "https://example.com/invalid-scheme";
    const client = new FakeHttpClient({
      [start]: { statusCode: 302, headers: { location: "/final" } },
      [final]: { body: "done" },
      [loop]: { statusCode: 302, headers: { location: loop } },
      [missing]: { statusCode: 302 },
      [invalid]: {
        statusCode: 302,
        headers: { location: "ftp://example.com/file" },
      },
    });
    const tool = new FetchUrlTool({ client });
    const result = await fetchResult(tool, start);
    assert.equal(result["url"], final);
    assert.equal(result["content"], "done");
    await assert.rejects(fetchResult(tool, loop), /重定向次数超过/);
    await assert.rejects(fetchResult(tool, missing), /缺少 Location/);
    await assert.rejects(fetchResult(tool, invalid), /http\/https/);
  });

  void it("supports explicit IP and CIDR deny lists", async () => {
    const url = "http://local.example/content";
    const client = new FakeHttpClient({ [url]: { body: "ok" } });
    const lookup = (): Promise<readonly { address: string; family: 4 }[]> =>
      Promise.resolve([{ address: "127.0.0.1", family: 4 }]);
    await assert.rejects(
      fetchResult(
        new FetchUrlTool({ client, lookup, denyList: ["127.0.0.1"] }),
        url,
      ),
      /黑名单/,
    );
    await assert.rejects(
      fetchResult(
        new FetchUrlTool({ client, lookup, denyList: ["127.0.0.0/8"] }),
        url,
      ),
      /黑名单/,
    );
    const allowed = await fetchResult(
      new FetchUrlTool({ client, lookup, denyList: ["10.0.0.0/8"] }),
      url,
    );
    assert.equal(allowed["content"], "ok");
  });
});
