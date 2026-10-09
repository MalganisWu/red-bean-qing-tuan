import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { describe, it, type TestContext } from "node:test";

import type { ToolCallContext } from "../../../../src/pipeline/context/runtime-context.js";
import {
  AllowAllEgressPolicy,
  PolicyHttpClient,
  PublicInternetOnlyPolicy,
  type HttpClientResponse,
  type PinnedRequest,
} from "../../../../src/tool/builtin/http-request/http-client.js";
import { FetchUrlTool } from "../../../../src/tool/builtin/fetch-url/fetch-url-tool.js";
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

async function listen(server: Server, test: TestContext): Promise<string> {
  await new Promise<void>((resolve, reject): void => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  test.after(
    (): Promise<void> =>
      new Promise<void>((resolve, reject): void => {
        server.close((error?: Error): void => {
          if (error) reject(error);
          else resolve();
        });
      }),
  );
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("test server has no TCP address");
  }
  return `http://127.0.0.1:${address.port}`;
}

void describe("Runtime TypeScript HTTP egress policy", () => {
  void it("rejects non-public targets while allowing a public address", async () => {
    const policy = new PublicInternetOnlyPolicy();
    for (const address of [
      "127.0.0.1",
      "10.0.0.1",
      "169.254.169.254",
      "100.64.0.1",
      "::1",
      "fc00::1",
    ]) {
      await assert.rejects(
        Promise.resolve().then((): Promise<void> | void =>
          policy.authorize("example", address, AbortSignal.timeout(1_000)),
        ),
        /受限地址/,
      );
    }
    await Promise.resolve(
      policy.authorize(
        "example.com",
        "93.184.216.34",
        AbortSignal.timeout(1_000),
      ),
    );
  });

  void it("pins an authorized DNS result and rejects a private result before connecting", async () => {
    let connectedAddress = "";
    const stop = new Error("stop after observing target");
    const connect: PinnedRequest = (
      _request,
      address,
    ): Promise<HttpClientResponse> => {
      connectedAddress = address.address;
      return Promise.reject(stop);
    };
    const publicClient = new PolicyHttpClient({
      lookup: (): Promise<readonly { address: string; family: 4 }[]> =>
        Promise.resolve([{ address: "93.184.216.34", family: 4 }]),
      connect,
    });
    await assert.rejects(
      publicClient.request(
        {
          method: "GET",
          url: new URL("https://agent.example/path"),
          headers: {},
          body: "",
          maxResponseBytes: 1_024,
        },
        AbortSignal.timeout(1_000),
      ),
      stop,
    );
    assert.equal(connectedAddress, "93.184.216.34");

    let privateConnectCalled = false;
    const privateClient = new PolicyHttpClient({
      lookup: (): Promise<readonly { address: string; family: 4 }[]> =>
        Promise.resolve([{ address: "127.0.0.1", family: 4 }]),
      connect: (): Promise<HttpClientResponse> => {
        privateConnectCalled = true;
        return Promise.reject(new Error("must not connect"));
      },
    });
    await assert.rejects(
      privateClient.request(
        {
          method: "GET",
          url: new URL("http://rebind.example"),
          headers: {},
          body: "",
          maxResponseBytes: 1_024,
        },
        AbortSignal.timeout(1_000),
      ),
      /受限地址/,
    );
    assert.equal(privateConnectCalled, false);
  });

  void it("rejects loopback by default for both HTTP tools", async (test) => {
    const url = await listen(
      createServer((_request, response): void => {
        response.end("secret");
      }),
      test,
    );
    await assert.rejects(
      new HttpRequestTool().execute(
        { method: "GET", url },
        context,
        AbortSignal.timeout(1_000),
      ),
      /受限地址/,
    );
    await assert.rejects(
      new FetchUrlTool().execute({ url }, context, AbortSignal.timeout(1_000)),
      /连接|受限地址/,
    );
  });

  void it("rechecks policy before following redirects", async (test) => {
    let reachedRedirectTarget = false;
    const server = createServer((request, response): void => {
      if (request.headers.host?.startsWith("localhost:")) {
        reachedRedirectTarget = true;
        response.end("secret");
        return;
      }
      const host = request.headers.host;
      if (host === undefined) throw new Error("request has no host");
      const port = host.split(":")[1];
      if (port === undefined) throw new Error("request host has no port");
      response.writeHead(302, { location: `http://localhost:${port}/secret` });
      response.end();
    });
    const url = await listen(server, test);
    const policy = {
      authorize(
        hostname: string,
        _address: string,
        _signal: AbortSignal,
      ): void {
        if (hostname === "localhost")
          throw new Error("redirect hostname blocked");
      },
    };
    const client = new PolicyHttpClient({ policy });
    for (const tool of [
      new HttpRequestTool(client),
      new FetchUrlTool({ client }),
    ]) {
      const params =
        tool.name === "sys_http_request" ? { method: "GET", url } : { url };
      await assert.rejects(
        tool.execute(params, context, AbortSignal.timeout(2_000)),
        /blocked|无法连接/,
      );
    }
    assert.equal(reachedRedirectTarget, false);
  });

  void it("supports an explicit allow-all policy for externally sandboxed hosts", async (test) => {
    const url = await listen(
      createServer((_request, response): void => {
        response.end("ok");
      }),
      test,
    );
    const client = new PolicyHttpClient({ policy: new AllowAllEgressPolicy() });
    const result = await new HttpRequestTool(client).execute(
      { method: "GET", url },
      context,
      AbortSignal.timeout(2_000),
    );
    assert.match(result.content, /"body":"ok"/);
  });
});
