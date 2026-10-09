import type { ToolCallContext } from "../../../protocol/run-identity.js";
import type { JsonObject, JsonValue } from "../../../protocol/json.js";
import type { Tool, ToolResult, ToolSchema } from "../../definition/tool.js";
import {
  defaultAddressLookup,
  IpDenyList,
  PolicyHttpClient,
  type AddressLookup,
  type HttpClient,
} from "../http-request/http-client.js";

export const FETCH_URL_TOOL_NAME = "sys_fetch_url";
export const MAX_FETCH_BODY_BYTES = 2 * 1_048_576;
export const MAX_FETCH_OUTPUT_BYTES = 64 * 1_024;
const MAX_REDIRECTS = 10;
const USER_AGENT = "red-bean-qing-tuan/0.1";
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/** 安全网页抓取工具的可替换网络依赖与地址拒绝列表。 */
export interface FetchUrlToolOptions {
  readonly client?: HttpClient | undefined;
  readonly denyList?: readonly string[] | undefined;
  readonly lookup?: AddressLookup | undefined;
}

interface TruncatedText {
  readonly value: string;
  readonly truncated: boolean;
}

interface ExtractedHtml {
  readonly title: string;
  readonly content: string;
  readonly truncated: boolean;
}

const PARAMETERS: JsonObject = {
  type: "object",
  properties: {
    url: {
      type: "string",
      description: "要访问的网页链接，必须以 http:// 或 https:// 开头",
    },
  },
  required: ["url"],
};

function isObject(value: JsonValue): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseUrl(value: JsonValue): URL {
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

function decodeEntity(entity: string): string {
  const named: Readonly<Record<string, string>> = {
    amp: "&",
    lt: "<",
    gt: ">",
    quot: '"',
    apos: "'",
    nbsp: " ",
  };
  const name = entity.slice(1, -1);
  const known = named[name];
  if (known !== undefined) return known;
  const numeric =
    name.startsWith("#x") || name.startsWith("#X")
      ? Number.parseInt(name.slice(2), 16)
      : name.startsWith("#")
        ? Number.parseInt(name.slice(1), 10)
        : Number.NaN;
  if (!Number.isSafeInteger(numeric) || numeric < 0 || numeric > 0x10ffff) {
    return entity;
  }
  try {
    return String.fromCodePoint(numeric);
  } catch (_cause: unknown) {
    return entity;
  }
}

function decodeEntities(value: string): string {
  return value.replace(/&(?:#\d+|#x[\da-f]+|[a-z]+);/gi, decodeEntity);
}

function normalizeText(value: string): string {
  const lines: string[] = [];
  for (const line of value.split("\n")) {
    const normalized = line.replace(/\s+/g, " ").trim();
    if (normalized.length > 0) lines.push(normalized);
  }
  return lines.join("\n");
}

function truncateUtf8(value: string, maximumBytes: number): TruncatedText {
  const encoded = new TextEncoder().encode(value);
  if (encoded.byteLength <= maximumBytes) {
    return { value, truncated: false };
  }
  let end = maximumBytes;
  const decoder = new TextDecoder("utf-8", { fatal: true });
  while (end > 0) {
    try {
      return {
        value: decoder.decode(encoded.subarray(0, end)),
        truncated: true,
      };
    } catch (_cause: unknown) {
      end -= 1;
    }
  }
  return { value: "", truncated: true };
}

function extractHtml(source: string): ExtractedHtml {
  const withoutIgnored = source.replace(
    /<(script|style|noscript)\b[^>]*>[\s\S]*?<\/\1\s*>/gi,
    "",
  );
  const titleMatch = /<title\b[^>]*>([\s\S]*?)<\/title\s*>/i.exec(
    withoutIgnored,
  );
  const rawTitle = titleMatch?.[1] ?? "";
  const title = truncateUtf8(
    normalizeText(decodeEntities(rawTitle.replace(/<[^>]*>/g, " "))),
    MAX_FETCH_OUTPUT_BYTES,
  );
  const withoutTitle = withoutIgnored.replace(
    /<title\b[^>]*>[\s\S]*?<\/title\s*>/gi,
    "",
  );
  const blockSeparated = withoutTitle.replace(
    /<\/?(?:h[1-6]|p|li|tr|br|ul|ol|table|blockquote|pre|section|article|div)\b[^>]*>/gi,
    "\n",
  );
  const content = truncateUtf8(
    normalizeText(decodeEntities(blockSeparated.replace(/<[^>]*>/g, " "))),
    MAX_FETCH_OUTPUT_BYTES,
  );
  return {
    title: title.value,
    content: content.value,
    truncated: title.truncated || content.truncated,
  };
}

/** 逐次校验重定向目标并限制响应大小的网页抓取工具，默认拒绝非公网地址。 */
export class FetchUrlTool implements Tool {
  public readonly name = FETCH_URL_TOOL_NAME;
  public readonly schema: ToolSchema = {
    type: "function",
    function: {
      name: this.name,
      description:
        '抓取指定 URL 并提取页面标题与正文可读文本；非 HTML 内容原样返回。返回 {"url": 最终地址, "title": 页面标题, "content": 文本, "truncated": 是否截断}',
      parameters: PARAMETERS,
    },
  };
  readonly #client: HttpClient;
  readonly #denyList: IpDenyList;
  readonly #lookup: AddressLookup;

  public constructor(options: FetchUrlToolOptions = {}) {
    this.#client = options.client ?? new PolicyHttpClient();
    this.#denyList = new IpDenyList(options.denyList ?? []);
    this.#lookup = options.lookup ?? defaultAddressLookup;
  }

  public async execute(
    value: JsonValue,
    _context: ToolCallContext,
    signal: AbortSignal,
  ): Promise<ToolResult> {
    if (!isObject(value)) throw new Error("fetch parameters must be an object");
    let target = parseUrl(value["url"] ?? null);
    for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects += 1) {
      await this.checkDenyList(target, signal);
      let response;
      try {
        response = await this.#client.request(
          {
            method: "GET",
            url: target,
            headers: { "user-agent": USER_AGENT },
            body: "",
            maxResponseBytes: MAX_FETCH_BODY_BYTES,
          },
          signal,
        );
      } catch (cause: unknown) {
        throw new Error("请求失败：无法连接目标主机", { cause });
      }
      if (REDIRECT_STATUSES.has(response.statusCode)) {
        if (redirects === MAX_REDIRECTS) {
          throw new Error(`重定向次数超过 ${MAX_REDIRECTS} 次`);
        }
        const location = response.headers["location"];
        if (location === undefined || location.length === 0) {
          throw new Error("重定向响应缺少 Location");
        }
        target = parseUrl(new URL(location, target).href);
        continue;
      }
      if (response.statusCode >= 400) {
        throw new Error(`目标返回 HTTP ${response.statusCode}`);
      }
      const body = new TextDecoder().decode(
        response.body.subarray(0, MAX_FETCH_BODY_BYTES),
      );
      const contentType = response.headers["content-type"] ?? "";
      let title: string;
      let content: string;
      let outputTruncated = response.truncated;
      if (contentType.includes("text/html")) {
        const extracted = extractHtml(body);
        title = extracted.title;
        content = extracted.content;
        outputTruncated = outputTruncated || extracted.truncated;
      } else {
        const raw = truncateUtf8(body, MAX_FETCH_OUTPUT_BYTES);
        title = "";
        content = raw.value;
        outputTruncated = outputTruncated || raw.truncated;
      }
      return {
        content: JSON.stringify({
          url: target.href,
          title,
          content,
          truncated: outputTruncated,
        }),
      };
    }
    throw new Error(`重定向次数超过 ${MAX_REDIRECTS} 次`);
  }

  private async checkDenyList(url: URL, signal: AbortSignal): Promise<void> {
    if (this.#denyList.empty) return;
    const addresses = await this.#lookup(url.hostname, signal);
    for (const address of addresses) {
      if (this.#denyList.includes(address.address)) {
        throw new Error(`目标地址 ${address.address} 在黑名单中，已拒绝`);
      }
    }
  }
}
