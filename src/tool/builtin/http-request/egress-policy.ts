import { lookup as dnsLookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";

import type {
  AddressLookup,
  EgressPolicy,
  ResolvedAddress,
} from "./http-contracts.js";

/** 取取消原因并抛出；优先沿用 `signal.reason`，不把它换成通用文案。 */
export function throwIfHttpAborted(signal: AbortSignal): void {
  if (!signal.aborted) return;
  throw signal.reason instanceof Error
    ? signal.reason
    : new DOMException("operation aborted", "AbortError");
}

/** 判定地址族；`BlockList.check` 必须传对 family，传错会静默匹配失败（等于放行）。 */
export function addressFamily(address: string): "ipv4" | "ipv6" {
  const family = isIP(address);
  if (family === 4) return "ipv4";
  if (family === 6) return "ipv6";
  throw new Error(`无效 IP 地址 ${JSON.stringify(address)}`);
}

/** 去掉 IPv6 字面量的方括号：`URL.hostname` 会保留 `[::1]`，而 DNS 与 socket 都不接受它。 */
export function unbracketHostname(hostname: string): string {
  return hostname.startsWith("[") && hostname.endsWith("]")
    ? hostname.slice(1, -1)
    : hostname;
}

/**
 * 受限网段清单。逐条对应一类「不该被工具访问到」的目标：
 * - `0.0.0.0/8`、`240.0.0.0/4`：保留/无效地址。
 * - `10/8`、`172.16/12`、`192.168/16`：私有网络，云上通常是内网控制面。
 * - `100.64/10`：运营商级 NAT（CGNAT），在 Tailscale 之类的方案里就是内网本身。
 * - `127/8`、`::1`：回环，能打到同机上的其他服务。
 * - `169.254/16`、`fe80::/10`：链路本地，云元数据服务（169.254.169.254）就在这一段。
 * - `224/4`、`ff00::/8`：组播。
 * - `fc00::/7`：IPv6 唯一本地地址。
 */
function buildRestrictedAddresses(): BlockList {
  const list = new BlockList();
  for (const [address, prefix] of [
    ["0.0.0.0", 8],
    ["10.0.0.0", 8],
    ["100.64.0.0", 10],
    ["127.0.0.0", 8],
    ["169.254.0.0", 16],
    ["172.16.0.0", 12],
    ["192.168.0.0", 16],
    ["224.0.0.0", 4],
    ["240.0.0.0", 4],
  ] satisfies readonly (readonly [string, number])[]) {
    list.addSubnet(address, prefix, "ipv4");
  }
  for (const [address, prefix] of [
    ["::", 128],
    ["::1", 128],
    ["fc00::", 7],
    ["fe80::", 10],
    ["ff00::", 8],
  ] satisfies readonly (readonly [string, number])[]) {
    list.addSubnet(address, prefix, "ipv6");
  }
  return list;
}

/** 默认出站策略拒绝回环、内网、链路本地和组播地址。 */
export class PublicInternetOnlyPolicy implements EgressPolicy {
  readonly #restricted = buildRestrictedAddresses();

  /**
   * 判定一个已解析的地址是否放行。
   *
   * **开头的 `::ffff:` 拦截不能省，也不能并入 BlockList 判断。**
   * IPv4-mapped IPv6 地址（`::ffff:127.0.0.1`）按 family 会被判为 ipv6，
   * 而清单里的内网网段是按 ipv4 注册的，`check` 根本匹配不上——
   * 于是攻击者只要把 `127.0.0.1` 写成映射形式就能绕过整张清单。
   * 这类地址一律拒绝，不做进一步判断；真实使用映射地址访问公网是极罕见的需求。
   */
  public authorize(
    hostname: string,
    address: string,
    signal: AbortSignal,
  ): void {
    throwIfHttpAborted(signal);
    if (
      address.toLowerCase().startsWith("::ffff:") ||
      this.#restricted.check(address, addressFamily(address))
    ) {
      throw new Error(
        `目标主机 ${JSON.stringify(hostname)} 解析到受限地址 ${address}`,
      );
    }
  }
}

/** 显式关闭 SDK 地址限制的策略，仅供已经提供外部网络沙箱的宿主选用。 */
export class AllowAllEgressPolicy implements EgressPolicy {
  public authorize(
    _hostname: string,
    _address: string,
    signal: AbortSignal,
  ): void {
    throwIfHttpAborted(signal);
  }
}

/**
 * 宿主可配的额外 IP 黑名单，与默认策略叠加使用。
 * 无效条目（格式错、前缀非法）被**静默忽略**并计数，`empty` 暴露「一条都没生效」——
 * 调用方据此可以跳过整个解析流程。之所以不抛错：这是运维配置，
 * 一条写错不该让 HTTP 工具整体不可用；但 `empty` 让「全部写错」这种情况能被发现。
 */
export class IpDenyList {
  readonly #entries = new BlockList();
  readonly #empty: boolean;

  public constructor(entries: readonly string[]) {
    let validEntries = 0;
    for (const entry of entries) {
      const separator = entry.lastIndexOf("/");
      try {
        if (separator > 0) {
          const address = entry.slice(0, separator);
          const prefix = Number(entry.slice(separator + 1));
          if (!Number.isSafeInteger(prefix)) continue;
          this.#entries.addSubnet(address, prefix, addressFamily(address));
          validEntries += 1;
        } else if (isIP(entry) !== 0) {
          this.#entries.addAddress(entry, addressFamily(entry));
          validEntries += 1;
        }
      } catch (_cause: unknown) {
        // 与既有契约一致：无效 deny-list 条目不参与匹配。
      }
    }
    this.#empty = validEntries === 0;
  }

  public get empty(): boolean {
    return this.#empty;
  }

  public includes(address: string): boolean {
    return this.#entries.check(address, addressFamily(address));
  }
}

/**
 * 默认 DNS 解析。
 * `all: true` 是关键：一个域名可能同时解析出公网与内网地址（DNS rebinding 的经典手法），
 * 只取第一条会让策略放过其中一半。这里把全部地址交给调用方逐个校验。
 * `verbatim: true` 保持解析顺序，不做 IPv4/IPv6 重排。
 */
export const defaultAddressLookup: AddressLookup = async (
  hostname: string,
  signal: AbortSignal,
): Promise<readonly ResolvedAddress[]> => {
  throwIfHttpAborted(signal);
  const addresses = await dnsLookup(unbracketHostname(hostname), {
    all: true,
    verbatim: true,
  });
  throwIfHttpAborted(signal);
  return addresses.flatMap((address): readonly ResolvedAddress[] =>
    address.family === 4 || address.family === 6
      ? [{ address: address.address, family: address.family }]
      : [],
  );
};
