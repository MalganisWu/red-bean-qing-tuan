import {
  request as requestHttp,
  type IncomingHttpHeaders,
  type IncomingMessage,
} from "node:http";
import { request as requestHttps, type RequestOptions } from "node:https";

import type {
  HttpClientRequest,
  HttpClientResponse,
  ResolvedAddress,
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

/**
 * 连接到策略已批准的固定 IP，避免授权后再次 DNS 解析产生 rebinding。
 *
 * 建连目标是 IP，但**三个地方仍保留原始主机名**，缺一不可：
 * - `headers.host`：HTTP/1.1 的虚拟主机路由靠它，不设会打到默认站点。
 * - `servername`：TLS SNI，不设会拿不到正确证书（多数 CDN 直接握手失败）。
 * - URL 路径与 query 保持原样。
 * 也就是说：**连接用 IP，语义用域名**。
 */

export function nativePinnedRequest(
  request: HttpClientRequest,
  address: ResolvedAddress,
  signal: AbortSignal,
  timeoutMilliseconds: number,
): Promise<HttpClientResponse> {
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
  return new Promise<HttpClientResponse>((resolve, reject): void =>
    sendAndCollect(resolve, reject, request, options, makeRequest),
  );
}

/**
 * 发出请求并把响应收集成 `HttpClientResponse`。
 *
 * 只结算一次（`settled`）：`end` 与 `error` 可能先后到达，第二次必须被忽略。
 * `maxResponseBytes + 1` 是刻意多读一个字节——正好读到上限时无法区分「刚好读完」
 * 与「被截断」，多收一字节才能确定是否该把 `truncated` 标成 true。
 */
function sendAndCollect(
  resolve: (response: HttpClientResponse) => void,
  reject: (error: Error) => void,
  request: HttpClientRequest,
  options: RequestOptions,
  makeRequest: typeof requestHttp,
): void {
  let settled = false;

  /** 只结算一次；返回 true 表示这次调用完成了结算。 */
  function settleOnce(): boolean {
    if (settled) return false;
    settled = true;
    return true;
  }

  function resolveOnce(response: HttpClientResponse): void {
    if (!settleOnce()) return;
    resolve(response);
  }

  function rejectOnce(error: Error): void {
    if (!settleOnce()) return;
    reject(error);
  }

  /** 收下响应：累积数据直到 `end`，超过上限即截断并销毁连接。 */
  function handleResponse(response: IncomingMessage): void {
    const chunks: Uint8Array[] = [];
    let bytes = 0;

    /** 结束：把已收字节交给调用方，`truncated` 说明是否被上限截断。 */
    function finish(truncated: boolean): void {
      resolveOnce({
        statusCode: response.statusCode ?? 0,
        headers: normalizeHeaders(response.headers),
        body: Buffer.concat(chunks, bytes),
        truncated,
      });
    }

    /** 收到一块数据；多读一个字节以区分「刚好读完」与「被截断」。 */
    function onData(chunk: unknown): void {
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
    }

    response.on("data", onData);
    response.once("end", (): void => finish(bytes > request.maxResponseBytes));
    response.once("error", rejectOnce);
  }

  const outgoing = makeRequest(options, handleResponse);
  outgoing.once("error", rejectOnce);
  if (request.body.length > 0) outgoing.write(request.body);
  outgoing.end();
}
