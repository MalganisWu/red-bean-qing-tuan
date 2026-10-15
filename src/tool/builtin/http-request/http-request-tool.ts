import type { ToolCallContext } from "../../../protocol/run-identity.js";
import type { JsonObject, JsonValue } from "../../../protocol/json.js";
import type { Tool, ToolResult, ToolSchema } from "../../definition/tool.js";
import {
  PolicyHttpClient,
  type HttpClient,
  type HttpClientResponse,
} from "./http-client.js";

/** 本工具在 Tool Registry 中的注册名；Agent 的 sys_tool_ids 用它引用，改名等于改变对外契约。 */
export const HTTP_REQUEST_TOOL_NAME = "sys_http_request";
/** 单次响应最多读取的字节数（1MiB）；超出即截断，避免一个大响应把上下文撑爆。 */
export const MAX_HTTP_RESPONSE_BYTES = 1_048_576;
/** 跟随跳转的最大次数；超过即报错，防止 A→B→A 的循环把工具挂死。 */
const MAX_REDIRECTS = 10;
/** 允许的 HTTP 方法白名单；不在此列的方法在解析阶段就被拒绝。 */
const ALLOWED_METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE"]);

/** 校验通过后的请求描述，字段均已归一化，可直接交给 HttpClient。 */
interface ParsedRequest {
  /** 已转大写并命中白名单的方法。 */
  readonly method: string;
  /** 解析后的目标 URL，协议已限定为 http/https。 */
  readonly url: URL;
  /** 校验通过的请求头，值保证是字符串。 */
  readonly headers: Readonly<Record<string, string>>;
  /** 请求体文本；未提供时为空字符串。 */
  readonly body: string;
}

/** 暴露给模型的 JSON Schema 入参：method/url 必填，headers/body 可选。 */
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

/**
 * 判定 JSON 值是否为普通对象（排除 null 与数组），作为后续字段读取的前置条件。
 *
 * @param value - 待判定的 JSON 值
 * @returns 是对象且非 null、非数组时为 true
 */
function isObject(value: JsonValue): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * 把入参里的 headers 归一化成「名字 → 字符串」映射。
 *
 * 数字、数组等非字符串值一律报错而不是强转：静默转换会让模型以为设置生效，
 * 实际发出去的却是别的值。缺省与 null 视为「没有请求头」。
 *
 * @param value - 入参中的 headers 原始值，允许 undefined / null
 * @returns 归一化后的请求头映射；无请求头时为空对象
 */
function parseHeaders(
  value: JsonValue | undefined,
): Readonly<Record<string, string>> {
  if (value === undefined || value === null) return {};
  if (!isObject(value)) throw new Error("headers 必须是对象");
  const headers: Record<string, string> = {};
  for (const [name, headerValue] of Object.entries(value)) {
    if (typeof headerValue !== "string") {
      throw new Error(`请求头 ${JSON.stringify(name)} 必须是字符串`);
    }
    headers[name] = headerValue;
  }
  return headers;
}

/**
 * 解析并校验目标 URL，只接受 http/https。
 *
 * 协议白名单是为了挡掉 `file:` 之类会让请求打到本地的 scheme；
 * 空值或非法 URL 直接抛错，避免带着半成品 URL 继续往下走。
 *
 * @param value - 入参中的 url 原始值
 * @returns 校验通过的 URL 对象
 */
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

/**
 * 校验工具入参并产出归一化的请求描述。
 *
 * 在这里一次性做完所有字段校验（对象形态、方法白名单、URL 协议、body 类型），
 * 让后续流程只需处理已验证的数据；任一字段非法即抛错，不做部分降级。
 *
 * @param value - 工具入参原始 JSON 值
 * @returns 归一化后的请求描述，可直接交给 HttpClient
 */
function parseRequest(value: JsonValue): ParsedRequest {
  if (!isObject(value)) throw new Error("HTTP 的参数必须是对象");
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
    throw new Error("body 必须是字符串");
  }
  return {
    method,
    url: parseUrl(value["url"]),
    headers: parseHeaders(value["headers"]),
    body: typeof rawBody === "string" ? rawBody : "",
  };
}

/**
 * 判定状态码是否为需要跟随的跳转。
 *
 * 只认 301/302/303/307/308 这五个：300、304、305 语义不同，
 * 跟随它们会改变请求含义或产生非预期行为。
 *
 * @param statusCode - 响应状态码
 * @returns 需要跟随跳转时为 true
 */
function isRedirect(statusCode: number): boolean {
  return [301, 302, 303, 307, 308].includes(statusCode);
}

/**
 * 重定向后的方法：301/302/303 把非 GET/HEAD 降级为 GET（配合下面清空 body），
 * 307/308 保持原方法。这是 HTTP 规范的既有语义，不是本项目的选择。
 *
 * @param statusCode - 重定向响应的状态码，决定是否降级
 * @param method - 当前这一跳使用的方法
 * @returns 下一跳应使用的方法
 */
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

/**
 * 跳转时**剥掉全部凭证类请求头**：`Authorization`、`Cookie`、`Proxy-Authorization`、`Host`。
 *
 * 防的是「凭证跟着 302 走」——攻击者只要能控制一次跳转目标，
 * 就能把模型带上的密钥原样收到自己服务器上。
 *
 * 实现是不分来源地一律剥掉，而不是只在跨域时剥：判断同源要解析两边的 origin 并处理各种边界
 * （端口、大小写、IDN），一处不严谨就等于没防。代价是同源跳转也会丢凭证——
 * 对「工具替模型发一次请求」这个场景可以接受，安全侧的收益远大于便利损失。
 *
 * @param headers - 当前这一跳的请求头
 * @returns 剥掉凭证类头之后的请求头
 */
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

/**
 * 校验结构化参数并通过受策略保护的 HttpClient 发起有限响应请求。
 *
 * **每一跳都重新走 `#client.request`**，这不是绕了远路，而是安全前提：
 * 出口策略（拒绝内网/回环/链路本地）因此对跳转目标同样生效。
 * 若只在第一跳做校验、之后自己重建连接，一个公网 URL 就能把请求重定向到
 * `169.254.169.254` 这类云元数据地址，整套出站防护形同虚设。
 *
 * 跳转目标还要重新过 `parseUrl`，顺带挡掉跳到 `file:` 之类协议的情况。
 * 循环上限 10 次，防止 A→B→A 的无限跳转把工具挂死。
 */
export class HttpRequestTool implements Tool {
  /** 本工具在 Tool Registry 中的注册名，与 `HTTP_REQUEST_TOOL_NAME` 保持一致。 */
  public readonly name = HTTP_REQUEST_TOOL_NAME;
  /** 工具契约：函数名、给模型的说明与 JSON Schema 入参。 */
  public readonly schema: ToolSchema = {
    type: "function",
    function: {
      name: this.name,
      description:
        "执行 HTTP 请求（任意方法/请求头/请求体），返回状态码与原始响应体。当需要调用已知 API 端点、测试接口、或精确控制请求方法与请求体时使用",
      parameters: PARAMETERS,
    },
  };
  /** 实际发包的 HTTP 客户端，构造时注入，便于测试替换。 */
  readonly #client: HttpClient;

  public constructor(client: HttpClient = new PolicyHttpClient()) {
    this.#client = client;
  }

  /**
   * 发起请求并跟随重定向。逐跳都经出口策略校验，跳转时按 HTTP 语义降级方法、清空 body 并剥掉凭证类请求头；
   * 响应体按字节上限截断后以 JSON 文本返回状态码与正文。
   *
   * @param value - 工具入参原始值，含 `method`、`url` 及可选 `headers`/`body`，尚未校验
   * @param _context - 未使用；保留以满足 `Tool` 契约
   * @param signal - 取消信号，传递给底层 HttpClient
   * @returns JSON 文本，含 `status_code` 与响应体
   */
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
