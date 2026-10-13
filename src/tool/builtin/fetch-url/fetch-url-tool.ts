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

/** 本工具在 Tool Registry 中的注册名；Agent 的 sys_tool_ids 用它引用，改名等于改变对外契约。 */
export const FETCH_URL_TOOL_NAME = "sys_fetch_url";
/** 从网络最多取回的响应体字节数（2MiB）。比交给模型的输出上限大，留出 HTML 抽取的余量。 */
export const MAX_FETCH_BODY_BYTES = 2 * 1_048_576;
/** 抽取后交给模型的文本上限（64KiB）；超出部分截断并置 `truncated`。 */
export const MAX_FETCH_OUTPUT_BYTES = 64 * 1_024;
/** 单次抓取允许跟随的最大重定向跳数；超过即报错，避免被不断跳转让请求永远不结束。 */
const MAX_REDIRECTS = 10;
/** 请求时统一附带的 User-Agent；标识本工具来源，避免被目标站按匿名客户端拒绝。 */
const USER_AGENT = "red-bean-qing-tuan/0.1";
/** 视为重定向的状态码集合；只有这些状态才会去读 Location 并继续跟随。 */
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/** 安全网页抓取工具的可替换网络依赖与地址拒绝列表。 */
export interface FetchUrlToolOptions {
  /** 发起请求的 HTTP 客户端；省略时用受策略约束的默认客户端。 */
  readonly client?: HttpClient | undefined;
  /** 追加到黑名单的地址条目；与本工具内建的拒绝列表取并集。 */
  readonly denyList?: readonly string[] | undefined;
  /** 主机名到 IP 的解析函数；省略时用系统 DNS，测试可注入固定结果。 */
  readonly lookup?: AddressLookup | undefined;
}

/** 按字节截断后的文本，以及它是否真的被截断的标记。 */
interface TruncatedText {
  /** 截断后的文本，保证落在合法的 UTF-8 边界上。 */
  readonly value: string;
  /** 是否发生了截断；为 false 时 `value` 即完整原文。 */
  readonly truncated: boolean;
}

/** 从 HTML 中抽取出的标题与正文，两者都已归一化并按输出上限截断。 */
interface ExtractedHtml {
  /** 页面标题文本；无 title 标签时为空串。 */
  readonly title: string;
  /** 去除标签后的正文可读文本。 */
  readonly content: string;
  /** 标题或正文任一被截断即为 true。 */
  readonly truncated: boolean;
}

/** 暴露给模型的 JSON Schema 入参：仅一个必填的 `url` 字符串。 */
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

/**
 * 判断 JSON 值是否为非数组的普通对象，用于把 unknown 形状的入参收窄。
 *
 * @param value - 待判定的 JSON 值，为 null 或数组时返回 false
 * @returns 是普通对象则为 true，供类型守卫收窄到 `JsonObject`
 */
function isObject(value: JsonValue): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * 把入参值解析成 URL 并校验协议；仅放行 http/https，其余一律拒绝。
 *
 * @param value - 待解析的原始值，非字符串或空串直接报错
 * @returns 解析并校验通过的 URL 对象
 */
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

/**
 * 把单个 HTML 实体还原成对应字符，覆盖命名实体与十/十六进制数字实体。
 *
 * 未知实体与超出 Unicode 范围的码点一律原样返回，避免因个别坏实体毁掉整页文本。
 *
 * @param entity - 形如 `&amp;` / `&#39;` / `&#x27;` 的完整实体串
 * @returns 还原后的字符；无法识别时原样返回入参
 */
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

/**
 * 把文本里的全部 HTML 实体替换成对应字符，抽取正文时据此还原可读内容。
 *
 * @param value - 含实体的原始文本
 * @returns 实体已还原的文本
 */
function decodeEntities(value: string): string {
  return value.replace(/&(?:#\d+|#x[\da-f]+|[a-z]+);/gi, decodeEntity);
}

/**
 * 归一化文本：压平每行内的连续空白并丢弃空行，得到适合交给模型的紧凑文本。
 *
 * @param value - 待归一化的原始文本
 * @returns 各行去除首尾空白、空行已删除后的文本
 */
function normalizeText(value: string): string {
  const lines: string[] = [];
  for (const line of value.split("\n")) {
    const normalized = line.replace(/\s+/g, " ").trim();
    if (normalized.length > 0) lines.push(normalized);
  }
  return lines.join("\n");
}

/**
 * 按字节上限截断文本，且不会切断多字节字符。
 *
 * 逐字节回退到能按 UTF-8 解码为止，因此结果始终是合法字符串；原文不超上限时原样返回。
 *
 * @param value - 待截断的原文
 * @param maximumBytes - 允许保留的最大 UTF-8 字节数
 * @returns 截断后的文本与是否发生截断的标记
 */
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

/**
 * 从 HTML 源码中抽取标题与正文可读文本。
 *
 * 先剔除 script/style/noscript，再把块级标签换成换行以保留段落，最后去标签、还原实体并归一化；
 * 标题与正文各自按输出上限截断，任一被截断即标记 `truncated`。
 *
 * @param source - 原始 HTML 源码
 * @returns 抽取出的标题、正文与是否截断
 */
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
  /** 本工具在 Tool Registry 中的注册名，与 `FETCH_URL_TOOL_NAME` 保持一致。 */
  public readonly name = FETCH_URL_TOOL_NAME;
  /** 工具契约：函数名、给模型的说明与 JSON Schema 入参。 */
  public readonly schema: ToolSchema = {
    type: "function",
    function: {
      name: this.name,
      description:
        '抓取指定 URL 并提取页面标题与正文可读文本；非 HTML 内容原样返回。返回 {"url": 最终地址, "title": 页面标题, "content": 文本, "truncated": 是否截断}',
      parameters: PARAMETERS,
    },
  };
  /** 发起 HTTP 请求的客户端；请求前的目标地址已由 `checkDenyList` 校验过。 */
  readonly #client: HttpClient;
  /** 解析结果命中即拒绝的 IP 黑名单；为空时整段跳过 DNS 解析。 */
  readonly #denyList: IpDenyList;
  /** 主机名解析函数；逐跳校验时用来取回该主机的全部 IP。 */
  readonly #lookup: AddressLookup;

  public constructor(options: FetchUrlToolOptions = {}) {
    this.#client = options.client ?? new PolicyHttpClient();
    this.#denyList = new IpDenyList(options.denyList ?? []);
    this.#lookup = options.lookup ?? defaultAddressLookup;
  }

  /**
   * 抓取单个 URL。逐跳跟随重定向，每跳都重新过黑名单与地址族校验，
   * 最终按内容类型决定抽取 HTML 还是原样返回，并对输出按字节上限截断。
   *
   * @param value - 工具入参原始值，仅使用其中的 `url` 字段，未校验
   * @param _context - 未使用；保留以满足 `Tool` 契约
   * @param signal - 取消信号，请求与逐跳校验时传递
   * @returns JSON 文本，含最终地址、标题、正文与是否截断
   */
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

  /**
   * 每次跳转都重新查黑名单，且对**所有**解析结果逐个判定。
   *
   * 两处都不可省：只在第一跳查，一次跳转就能绕到黑名单里的地址；
   * 只看第一条解析结果，一个同时解析出白名单与黑名单地址的域名就能蒙混过关。
   * `empty` 时直接返回，省掉一次 DNS。
   *
   * @param url - 本跳要访问的目标地址，只用其 hostname 做解析
   * @param signal - 取消信号，DNS 解析期间可被中止
   */
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
