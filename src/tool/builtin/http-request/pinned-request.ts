import { request as requestHttp, type IncomingHttpHeaders } from "node:http";
import { request as requestHttps, type RequestOptions } from "node:https";

import type {
  HttpClientRequest,
  HttpClientResponse,
  PinnedRequest,
} from "./http-contracts.js";
import { unbracketHostname } from "./egress-policy.js";

function normalizeHeaders(
  headers: IncomingHttpHeaders,
): Readonly<Record<string, string>> {
  const normalized: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (typeof value === "string") normalized[name] = value;
    else if (Array.isArray(value)) normalized[name] = value.join(", ");
  }
  return normalized;
}

/** 连接到策略已批准的固定 IP，避免授权后再次 DNS 解析产生 rebinding。 */
export const nativePinnedRequest: PinnedRequest = (
  request: HttpClientRequest,
  address,
  signal: AbortSignal,
  timeoutMilliseconds: number,
): Promise<HttpClientResponse> => {
  const combinedSignal = AbortSignal.any([
    signal,
    AbortSignal.timeout(timeoutMilliseconds),
  ]);
  const options: RequestOptions = {
    protocol: request.url.protocol,
    hostname: address.address,
    family: address.family,
    port: request.url.port.length > 0 ? request.url.port : undefined,
    path: `${request.url.pathname}${request.url.search}`,
    method: request.method,
    headers: { ...request.headers, host: request.url.host },
    signal: combinedSignal,
    servername: unbracketHostname(request.url.hostname),
  };
  const makeRequest =
    request.url.protocol === "https:" ? requestHttps : requestHttp;
  return new Promise<HttpClientResponse>((resolve, reject): void => {
    let settled = false;
    const resolveOnce = (response: HttpClientResponse): void => {
      if (settled) return;
      settled = true;
      resolve(response);
    };
    const rejectOnce = (error: Error): void => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    const outgoing = makeRequest(options, (response): void => {
      const chunks: Uint8Array[] = [];
      let bytes = 0;
      const finish = (truncated: boolean): void => {
        resolveOnce({
          statusCode: response.statusCode ?? 0,
          headers: normalizeHeaders(response.headers),
          body: Buffer.concat(chunks, bytes),
          truncated,
        });
      };
      response.on("data", (chunk: unknown): void => {
        if (settled) return;
        const data =
          typeof chunk === "string"
            ? Buffer.from(chunk)
            : chunk instanceof Uint8Array
              ? chunk
              : undefined;
        if (data === undefined) {
          response.destroy(new Error("响应包含未知数据块"));
          return;
        }
        const remaining = request.maxResponseBytes + 1 - bytes;
        if (remaining > 0) {
          const accepted = data.subarray(0, remaining);
          chunks.push(accepted);
          bytes += accepted.byteLength;
        }
        if (bytes > request.maxResponseBytes) {
          finish(true);
          response.destroy();
        }
      });
      response.once("end", (): void =>
        finish(bytes > request.maxResponseBytes),
      );
      response.once("error", rejectOnce);
    });
    outgoing.once("error", rejectOnce);
    if (request.body.length > 0) outgoing.write(request.body);
    outgoing.end();
  });
};
