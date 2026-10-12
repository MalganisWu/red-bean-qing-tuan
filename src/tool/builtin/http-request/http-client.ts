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
  return new Promise<TValue>((resolve, reject): void => {
    let settled = false;
    const cleanup = (): void => signal.removeEventListener("abort", onAbort);
    const onAbort = (): void => {
      if (settled) return;
      settled = true;
      cleanup();
      try {
        throwIfHttpAborted(signal);
      } catch (cause: unknown) {
        reject(cause instanceof Error ? cause : new Error(String(cause)));
      }
    };
    signal.addEventListener("abort", onAbort, { once: true });
    void operation.then(
      (value: TValue): void => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(value);
      },
      (cause: unknown): void => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(cause instanceof Error ? cause : new Error(String(cause)));
      },
    );
  });
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
