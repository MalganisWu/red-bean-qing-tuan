import { lookup as dnsLookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";

import type {
  AddressLookup,
  EgressPolicy,
  ResolvedAddress,
} from "./http-contracts.js";

export function throwIfHttpAborted(signal: AbortSignal): void {
  if (!signal.aborted) return;
  throw signal.reason instanceof Error
    ? signal.reason
    : new DOMException("operation aborted", "AbortError");
}

export function addressFamily(address: string): "ipv4" | "ipv6" {
  const family = isIP(address);
  if (family === 4) return "ipv4";
  if (family === 6) return "ipv6";
  throw new Error(`无效 IP 地址 ${JSON.stringify(address)}`);
}

export function unbracketHostname(hostname: string): string {
  return hostname.startsWith("[") && hostname.endsWith("]")
    ? hostname.slice(1, -1)
    : hostname;
}

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
