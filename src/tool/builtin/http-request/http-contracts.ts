/** DNS 解析后的固定地址，连接阶段不得再次解析主机名。 */
export interface ResolvedAddress {
  readonly address: string;
  readonly family: 4 | 6;
}

/** 交给安全 HTTP 客户端的完整请求与响应体上限。 */
export interface HttpClientRequest {
  readonly method: string;
  readonly url: URL;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
  readonly maxResponseBytes: number;
}

/** 已限制响应体大小的 HTTP 结果；truncated 明确表示发生截断。 */
export interface HttpClientResponse {
  readonly statusCode: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: Uint8Array;
  readonly truncated: boolean;
}

/** HTTP 传输 Port；安全策略必须在具体实现中显式注入。 */
export interface HttpClient {
  request(
    request: HttpClientRequest,
    signal: AbortSignal,
  ): Promise<HttpClientResponse>;
}

/** DNS 地址授权策略；默认实现拒绝非公网地址。 */
export interface EgressPolicy {
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
  readonly timeoutMilliseconds?: number | undefined;
  readonly policy?: EgressPolicy | undefined;
  readonly lookup?: AddressLookup | undefined;
  readonly connect?: PinnedRequest | undefined;
}
