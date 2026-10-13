/** DNS 解析后的固定地址，连接阶段不得再次解析主机名。 */
export interface ResolvedAddress {
  /** 解析得到的 IP 字面量，连接阶段直接用它，不再走系统解析。 */
  readonly address: string;
  /** IP 地址族（4 或 6）；建连与黑名单匹配都要按它选路径。 */
  readonly family: 4 | 6;
}

/** 交给安全 HTTP 客户端的完整请求与响应体上限。 */
export interface HttpClientRequest {
  /** HTTP 方法，已由上层校验为大写白名单值。 */
  readonly method: string;
  /** 目标 URL；连接只取其主机名语义，实际连接目标是已授权的 IP。 */
  readonly url: URL;
  /** 出站请求头；跳转时的凭证类头由上层负责剥除。 */
  readonly headers: Readonly<Record<string, string>>;
  /** 请求体文本；无请求体时为空字符串而非 undefined。 */
  readonly body: string;
  /** 响应体读取上限（字节），超出即截断，防止大响应撑爆上下文。 */
  readonly maxResponseBytes: number;
}

/** 已限制响应体大小的 HTTP 结果；truncated 明确表示发生截断。 */
export interface HttpClientResponse {
  /** HTTP 状态码；底层拿不到时为 0。 */
  readonly statusCode: number;
  /** 响应头，已归一化为「名字 → 字符串」，多值用逗号连接。 */
  readonly headers: Readonly<Record<string, string>>;
  /** 响应体字节；长度不会超过请求声明的上限。 */
  readonly body: Uint8Array;
  /** 是否因超过上限被截断；为 true 时体并不完整。 */
  readonly truncated: boolean;
}

/** HTTP 传输 Port；安全策略必须在具体实现中显式注入。 */
export interface HttpClient {
  /**
   * 发起一次受安全策略约束的 HTTP 请求。
   *
   * 实现必须先解析地址并逐个授权，再用已授权的 IP 建连；
   * 不允许在建连阶段重新解析主机名，否则等于给 DNS 重绑定留后门。
   *
   * @param request - 出站请求描述，含方法、URL、请求头与响应体上限
   * @param signal - 取消信号，中止后实现须尽快停止发包
   * @returns 目标返回的状态码、响应头与（受限的）响应体
   */
  request(
    request: HttpClientRequest,
    signal: AbortSignal,
  ): Promise<HttpClientResponse>;
}

/** DNS 地址授权策略；默认实现拒绝非公网地址。 */
export interface EgressPolicy {
  /**
   * 判定一个已解析的地址是否允许连接；拒绝时通过抛错表达。
   *
   * 实现拿到的是**具体 IP** 而非主机名，因此判定结果对同一次连接始终成立，
   * 调用方据此固定该 IP 建连，不给第二次解析留机会。
   *
   * @param hostname - 原始主机名，仅供错误信息使用，不参与匹配
   * @param address - 已解析的 IP 字面量，是唯一参与匹配的值
   * @param signal - 取消信号，判定前后应检查
   * @returns 放行时正常返回；拒绝以抛错表达，而非返回假值
   */
  authorize(
    hostname: string,
    address: string,
    signal: AbortSignal,
  ): Promise<void> | void;
}

/** 可取消的 DNS 解析 Port；返回地址仍须经过 EgressPolicy 授权。 */
export type AddressLookup = (
  hostname: string,
  signal: AbortSignal,
) => Promise<readonly ResolvedAddress[]>;

/** 将请求固定连接到已授权地址的传输 Port，避免 DNS 重绑定。 */
export type PinnedRequest = (
  request: HttpClientRequest,
  address: ResolvedAddress,
  signal: AbortSignal,
  timeoutMilliseconds: number,
) => Promise<HttpClientResponse>;

/** PolicyHttpClient 的安全策略和宿主网络能力配置。 */
export interface PolicyHttpClientOptions {
  /** 单次请求超时毫秒数；省略或非正数时回退到默认值。 */
  readonly timeoutMilliseconds?: number | undefined;
  /** 地址授权策略；省略时用只放行公网的默认策略。 */
  readonly policy?: EgressPolicy | undefined;
  /** DNS 解析 Port；省略时用系统解析并返回全部地址。 */
  readonly lookup?: AddressLookup | undefined;
  /** 固定 IP 建连的传输 Port；省略时用原生 http/https 实现。 */
  readonly connect?: PinnedRequest | undefined;
}
