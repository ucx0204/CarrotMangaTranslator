import { lookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";
import type { WebImportScanRejectionReason } from "../shared/webImportTypes";

type WebImportDnsAddress = {
  address: string;
  family: number;
};

export type WebImportDnsLookup = (
  hostname: string,
) => Promise<readonly WebImportDnsAddress[]>;

export class WebImportUrlError extends Error {
  constructor(
    readonly reason: Extract<
      WebImportScanRejectionReason,
      "invalid-url" | "private-address" | "page-unavailable"
    >,
  ) {
    super(`Web import URL rejected: ${reason}`);
    this.name = "WebImportUrlError";
  }
}

const blockedAddresses = createBlockedAddressList();
const BLOCKED_HOST_SUFFIXES = [
  ".internal",
  ".local",
  ".localhost",
  ".home.arpa",
] as const;

export async function assertPublicWebImportUrl(
  rawUrl: string,
  dnsLookup: WebImportDnsLookup = productionDnsLookup,
): Promise<URL> {
  const url = parseWebImportUrl(rawUrl);
  const hostname = normalizeHostname(url.hostname);
  if (isBlockedHostname(hostname)) {
    throw new WebImportUrlError("private-address");
  }

  const family = isIP(hostname);
  if (family !== 0) {
    if (!isPublicIpAddress(hostname, family)) {
      throw new WebImportUrlError("private-address");
    }
    return url;
  }

  let addresses: readonly WebImportDnsAddress[];
  try {
    addresses = await dnsLookup(hostname);
  } catch (_error) {
    throw new WebImportUrlError("page-unavailable");
  }
  if (addresses.length === 0) {
    throw new WebImportUrlError("page-unavailable");
  }
  if (
    addresses.some(
      ({ address, family: addressFamily }) =>
        !isPublicIpAddress(address, addressFamily),
    )
  ) {
    throw new WebImportUrlError("private-address");
  }
  return url;
}

export async function isAllowedWebImportRequest(
  rawUrl: string,
  dnsLookup: WebImportDnsLookup = productionDnsLookup,
): Promise<boolean> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch (_error) {
    return false;
  }
  if (["about:", "blob:", "data:"].includes(url.protocol)) {
    return url.protocol !== "about:" || url.href === "about:blank";
  }
  try {
    await assertPublicWebImportUrl(rawUrl, dnsLookup);
    return true;
  } catch (_error) {
    return false;
  }
}

export function isPublicIpAddress(
  address: string,
  family = isIP(address),
): boolean {
  const normalized = normalizeHostname(address);
  if (family === 4) {
    return !blockedAddresses.check(normalized, "ipv4");
  }
  if (family === 6) {
    return !blockedAddresses.check(normalized, "ipv6");
  }
  return false;
}

export function canonicalizeWebImageUrl(rawUrl: string): string | null {
  try {
    const url = parseWebImportUrl(rawUrl);
    url.hash = "";
    return url.href;
  } catch (_error) {
    return null;
  }
}

function parseWebImportUrl(rawUrl: string): URL {
  let url: URL;
  try {
    url = new URL(rawUrl.trim());
  } catch (_error) {
    throw new WebImportUrlError("invalid-url");
  }
  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    Boolean(url.username) ||
    Boolean(url.password) ||
    !url.hostname
  ) {
    throw new WebImportUrlError("invalid-url");
  }
  url.hash = "";
  return url;
}

function normalizeHostname(hostname: string): string {
  return hostname
    .replace(/^\[|\]$/g, "")
    .replace(/\.$/, "")
    .toLowerCase();
}

function isBlockedHostname(hostname: string): boolean {
  return (
    hostname === "localhost" ||
    hostname === "localhost.localdomain" ||
    BLOCKED_HOST_SUFFIXES.some((suffix) => hostname.endsWith(suffix))
  );
}

async function productionDnsLookup(
  hostname: string,
): Promise<readonly WebImportDnsAddress[]> {
  return lookup(hostname, { all: true, verbatim: true });
}

function createBlockedAddressList(): BlockList {
  const list = new BlockList();
  const ipv4Subnets: ReadonlyArray<readonly [string, number]> = [
    ["0.0.0.0", 8],
    ["10.0.0.0", 8],
    ["100.64.0.0", 10],
    ["127.0.0.0", 8],
    ["169.254.0.0", 16],
    ["172.16.0.0", 12],
    ["192.0.0.0", 24],
    ["192.0.2.0", 24],
    ["192.168.0.0", 16],
    ["198.18.0.0", 15],
    ["198.51.100.0", 24],
    ["203.0.113.0", 24],
    ["224.0.0.0", 4],
    ["240.0.0.0", 4],
  ];
  const ipv6Subnets: ReadonlyArray<readonly [string, number]> = [
    ["::", 128],
    ["::1", 128],
    ["64:ff9b::", 96],
    ["64:ff9b:1::", 48],
    ["100::", 64],
    ["2001::", 32],
    ["2001:2::", 48],
    ["2001:10::", 28],
    ["2001:db8::", 32],
    ["2002::", 16],
    ["fc00::", 7],
    ["fe80::", 10],
    ["ff00::", 8],
  ];
  for (const [network, prefix] of ipv4Subnets) {
    list.addSubnet(network, prefix, "ipv4");
  }
  for (const [network, prefix] of ipv6Subnets) {
    list.addSubnet(network, prefix, "ipv6");
  }
  return list;
}
