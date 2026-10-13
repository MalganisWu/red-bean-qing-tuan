import {
  PublicInternetOnlyPolicy,
  defaultAddressLookup,
  throwIfHttpAborted,
  unbracketHostname,
} from "./egress-policy.js";
import { nativePinnedRequest } from "./pinned-request.js";
import type {
  AddressLookup,
  EgressPolicy,
  HttpClient,
  HttpClientRequest,
  HttpClientResponse,
  PinnedRequest,
  PolicyHttpClientOptions,
} from "./http-contracts.js";

export {
  AllowAllEgressPolicy,
  IpDenyList,
  PublicInternetOnlyPolicy,
  defaultAddressLookup,
} from "./egress-policy.js";
export type {
  AddressLookup,
  EgressPolicy,
  HttpClient,
  HttpClientRequest,
  HttpClientResponse,
  PinnedRequest,
  PolicyHttpClientOptions,
  ResolvedAddress,
} from "./http-contracts.js";

const DEFAULT_TIMEOUT_MILLISECONDS = 30_000;

function abortable<TValue>(
  operation: Promise<TValue>,
  signal: AbortSignal,
): Promise<TValue> {
  throwIfHttpAborted(signal);
  const { promise, resolve, reject } = Promise.withResolvers<TValue>();
  let settled = false;

  /** 只结算一次：标记已定、摘掉取消监听，再把结果交出去。 */
  function settleOnce(deliver: () => void): void {
    if (settled) return;
    settled = true;
    signal.removeEventListener("abort", onAbort);
    deliver();
  }

  /** 未知原因统一成 Error 再拒绝，避免把非 Error 抛给调用方。 */
  function rejectUnknown(cause: unknown): void {
    reject(cause instanceof Error ? cause : new Error(String(cause)));
  }

  /** 取消先于结果到达：以取消原因结算。 */
  function onAbort(): void {
    let cancellation: unknown;
    try {
      throwIfHttpAborted(signal);
      return;
    } catch (cause: unknown) {
      cancellation = cause;
    }
    settleOnce((): void => rejectUnknown(cancellation));
  }

  signal.addEventListener("abort", onAbort, { once: true });
  void operation.then(
    (value: TValue): void => settleOnce((): void => resolve(value)),
    (cause: unknown): void => settleOnce((): void => rejectUnknown(cause)),
  );
  return promise;
}

/**
 * HTTP 能力的默认实现：先解析并逐个授权地址，再固定 IP 建连。
 * 所有地址失败时返回最后一次明确错误，且取消信号始终优先。
 *
 * 「解析 → 授权 → 固定 IP 建连」这三步的顺序就是防 DNS rebinding 的全套动作：
 * 授权针对的是**具体 IP**，而建连也用同一个 IP，中间不再给 DNS 第二次机会。
 * 若在建连时让系统重新解析，攻击者只要让第二次解析返回内网地址即可绕过授权。
 *
 * 逐地址尝试是因为一个域名常有多个解析结果（IPv4/IPv6、多机房），
 * 其中一个不可用不该让整个请求失败；但**取消必须立刻终止**，
 * 所以每次失败后先 `throwIfHttpAborted` 再决定要不要试下一个地址。
 */
export class PolicyHttpClient implements HttpClient {
  readonly #timeoutMilliseconds: number;
  readonly #policy: EgressPolicy;
  readonly #lookup: AddressLookup;
  readonly #connect: PinnedRequest;

  public constructor(options: PolicyHttpClientOptions = {}) {
    this.#timeoutMilliseconds =
      options.timeoutMilliseconds !== undefined &&
      options.timeoutMilliseconds > 0
        ? options.timeoutMilliseconds
        : DEFAULT_TIMEOUT_MILLISECONDS;
    this.#policy = options.policy ?? new PublicInternetOnlyPolicy();
    this.#lookup = options.lookup ?? defaultAddressLookup;
    this.#connect = options.connect ?? nativePinnedRequest;
  }

  /**
   * 解析主机、逐个授权地址并固定 IP 建连。任一地址被策略拒绝则跳到下一个，
   * 全部失败时抛最后一次错误；取消优先于「换下一个地址」，避免中止后继续发包。
   *
   * @param request - 出站请求描述，连接仍用其原始 URL 的路径与主机名语义
   * @param signal - 调用方的取消信号，与实例超时合并为操作信号
   * @returns 目标返回的状态码、响应头与（受限的）响应体
   */
  public async request(
    request: HttpClientRequest,
    signal: AbortSignal,
  ): Promise<HttpClientResponse> {
    const operationSignal = AbortSignal.any([
      signal,
      AbortSignal.timeout(this.#timeoutMilliseconds),
    ]);
    throwIfHttpAborted(operationSignal);
    const hostname = unbracketHostname(request.url.hostname);
    const addresses = await abortable(
      this.#lookup(hostname, operationSignal),
      operationSignal,
    );
    let lastError: Error | undefined;
    for (const address of addresses) {
      try {
        await this.#policy.authorize(
          hostname,
          address.address,
          operationSignal,
        );
      } catch (cause: unknown) {
        lastError = cause instanceof Error ? cause : new Error(String(cause));
        continue;
      }
      try {
        return await this.#connect(
          request,
          address,
          operationSignal,
          this.#timeoutMilliseconds,
        );
      } catch (cause: unknown) {
        // 先判取消再记错误：把一次取消当成「这个地址不可用」而继续试下一个，
        // 会让已经中止的请求继续对外发包。
        throwIfHttpAborted(operationSignal);
        lastError = cause instanceof Error ? cause : new Error(String(cause));
      }
    }
    throw (
      lastError ??
      new Error(`目标主机 ${JSON.stringify(hostname)} 没有可用地址`)
    );
  }
}
