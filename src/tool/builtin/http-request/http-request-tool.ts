import type { ToolCallContext } from "../../../protocol/run-identity.js";
import type { JsonObject, JsonValue } from "../../../protocol/json.js";
import type { Tool, ToolResult, ToolSchema } from "../../definition/tool.js";
import {
  PolicyHttpClient,
  type HttpClient,
  type HttpClientResponse,
} from "./http-client.js";

export const HTTP_REQUEST_TOOL_NAME = "sys_http_request";
export const MAX_HTTP_RESPONSE_BYTES = 1_048_576;
const MAX_REDIRECTS = 10;
const ALLOWED_METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE"]);

interface ParsedRequest {
  readonly method: string;
  readonly url: URL;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
}

const PARAMETERS: JsonObject = {
  type: "object",
  properties: {
    method: {
      type: "string",
      enum: ["GET", "POST", "PUT", "PATCH", "DELETE"],
      description: "HTTP 方法",
    },
    url: { type: "string", description: "请求 URL" },
    headers: { type: "object", description: "请求头（可选）" },
    body: { type: "string", description: "请求体，JSON 字符串（可选）" },
  },
  required: ["method", "url"],
};

function isObject(value: JsonValue): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseHeaders(
  value: JsonValue | undefined,
): Readonly<Record<string, string>> {
  if (value === undefined || value === null) return {};
  if (!isObject(value)) throw new Error("headers must be an object");
  const headers: Record<string, string> = {};
  for (const [name, headerValue] of Object.entries(value)) {
    if (typeof headerValue !== "string") {
      throw new Error(`header ${JSON.stringify(name)} must be a string`);
    }
    headers[name] = headerValue;
  }
  return headers;
}

function parseUrl(value: JsonValue | undefined): URL {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error("url 不能为空");
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch (cause: unknown) {
    throw new Error("URL 无效", { cause });
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(
      `仅支持 http/https 协议，收到 ${JSON.stringify(url.protocol)}`,
    );
  }
  return url;
}

function parseRequest(value: JsonValue): ParsedRequest {
  if (!isObject(value)) throw new Error("HTTP parameters must be an object");
  const rawMethod = value["method"];
  if (typeof rawMethod !== "string") throw new Error("method 不能为空");
  const method = rawMethod.toUpperCase();
  if (!ALLOWED_METHODS.has(method)) {
    throw new Error(`不支持 HTTP 方法 ${JSON.stringify(rawMethod)}`);
  }
  const rawBody = value["body"];
  if (
    rawBody !== undefined &&
    rawBody !== null &&
    typeof rawBody !== "string"
  ) {
    throw new Error("body must be a string");
  }
  return {
    method,
    url: parseUrl(value["url"]),
    headers: parseHeaders(value["headers"]),
    body: typeof rawBody === "string" ? rawBody : "",
  };
}

function isRedirect(statusCode: number): boolean {
  return [301, 302, 303, 307, 308].includes(statusCode);
}

function redirectedMethod(statusCode: number, method: string): string {
  if (
    (statusCode === 301 || statusCode === 302 || statusCode === 303) &&
    method !== "GET" &&
    method !== "HEAD"
  ) {
    return "GET";
  }
  return method;
}

function redirectedHeaders(
  headers: Readonly<Record<string, string>>,
): Readonly<Record<string, string>> {
  const forwarded: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    const normalized = name.toLowerCase();
    if (
      normalized !== "authorization" &&
      normalized !== "cookie" &&
      normalized !== "proxy-authorization" &&
      normalized !== "host"
    ) {
      forwarded[name] = value;
    }
  }
  return forwarded;
}

/** 校验结构化参数并通过受策略保护的 HttpClient 发起有限响应请求。 */
export class HttpRequestTool implements Tool {
  public readonly name = HTTP_REQUEST_TOOL_NAME;
  public readonly schema: ToolSchema = {
    type: "function",
    function: {
      name: this.name,
      description:
        "执行 HTTP 请求（任意方法/请求头/请求体），返回状态码与原始响应体。当需要调用已知 API 端点、测试接口、或精确控制请求方法与请求体时使用",
      parameters: PARAMETERS,
    },
  };
  readonly #client: HttpClient;

  public constructor(client: HttpClient = new PolicyHttpClient()) {
    this.#client = client;
  }

  public async execute(
    value: JsonValue,
    _context: ToolCallContext,
    signal: AbortSignal,
  ): Promise<ToolResult> {
    const parsed = parseRequest(value);
    let target = parsed.url;
    let method = parsed.method;
    let body = parsed.body;
    let headers = parsed.headers;
    let response: HttpClientResponse | undefined;
    for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects += 1) {
      response = await this.#client.request(
        {
          method,
          url: target,
          headers,
          body,
          maxResponseBytes: MAX_HTTP_RESPONSE_BYTES,
        },
        signal,
      );
      if (!isRedirect(response.statusCode)) break;
      if (redirects === MAX_REDIRECTS) {
        throw new Error(`重定向次数超过 ${MAX_REDIRECTS} 次`);
      }
      const location = response.headers["location"];
      if (location === undefined || location.length === 0) {
        throw new Error("重定向响应缺少 Location");
      }
      target = parseUrl(new URL(location, target).href);
      const nextMethod = redirectedMethod(response.statusCode, method);
      if (nextMethod !== method) body = "";
      method = nextMethod;
      headers = redirectedHeaders(headers);
    }
    if (response === undefined) throw new Error("HTTP 请求未产生响应");
    const responseBody = response.body.subarray(0, MAX_HTTP_RESPONSE_BYTES);
    return {
      content: JSON.stringify({
        status_code: response.statusCode,
        body: new TextDecoder().decode(responseBody),
      }),
    };
  }
}
