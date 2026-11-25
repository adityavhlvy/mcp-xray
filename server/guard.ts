import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

/**
 * The inspector fetches URLs that strangers type in. Without this guard the
 * function is a free proxy into the deployment's private network, including
 * the cloud metadata endpoint. Every hop is checked, not just the first.
 */

export class GuardError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GuardError";
  }
}

const BLOCKED_V4: Array<[string, number]> = [
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

function v4ToInt(address: string): number {
  return address.split(".").reduce((acc, part) => (acc << 8) + Number(part), 0) >>> 0;
}

function inV4Range(address: string, base: string, bits: number): boolean {
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return (v4ToInt(address) & mask) === (v4ToInt(base) & mask);
}

/** True for loopback, private, link-local, CGNAT, multicast, and reserved. */
export function isPrivateV4(address: string): boolean {
  return BLOCKED_V4.some(([base, bits]) => inV4Range(address, base, bits));
}

export function isPrivateV6(address: string): boolean {
  const value = address.toLowerCase().split("%")[0];

  // ::ffff:10.0.0.1 is an IPv4 address wearing an IPv6 hat.
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(value);
  if (mapped) return isPrivateV4(mapped[1]);

  if (value === "::" || value === "::1") return true;
  if (value.startsWith("fe80")) return true; // link-local
  if (value.startsWith("fc") || value.startsWith("fd")) return true; // unique local
  if (value.startsWith("ff")) return true; // multicast
  if (value.startsWith("64:ff9b")) return true; // NAT64
  if (value.startsWith("2001:db8")) return true; // documentation
  return false;
}

export function isPrivateAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return isPrivateV4(address);
  if (family === 6) return isPrivateV6(address);
  return true;
}

const BLOCKED_HOSTS = new Set([
  "localhost",
  "metadata",
  "metadata.google.internal",
  "instance-data",
  "kubernetes.default",
  "kubernetes.default.svc",
]);

function isBlockedHostname(hostname: string): boolean {
  const name = hostname.toLowerCase().replace(/\.$/, "");
  if (BLOCKED_HOSTS.has(name)) return true;
  if (name.endsWith(".localhost") || name.endsWith(".local") || name.endsWith(".internal")) return true;
  if (name.endsWith(".svc") || name.endsWith(".cluster.local")) return true;
  return false;
}

export interface SafeUrl {
  url: URL;
  /** Every address the hostname resolved to, already checked. */
  addresses: string[];
}

export interface GuardOptions {
  /**
   * Test-only seam. Never set from a request. When true, private addresses
   * pass so the local mock can be inspected in one process.
   */
  allowPrivate?: boolean;
}

/**
 * Validates the shape of the URL and resolves the hostname. Resolution happens
 * here, before the request, so a hostname that points at a private address is
 * rejected even though the URL itself looks public.
 */
export async function assertPublicUrl(raw: string, options: GuardOptions = {}): Promise<SafeUrl> {
  const allowPrivate = options.allowPrivate === true;

  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new GuardError("That is not a complete URL. Include https://");
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new GuardError("Only http and https endpoints can be inspected.");
  }
  if (url.username || url.password) {
    throw new GuardError("Remove the username and password from the URL.");
  }
  if (isBlockedHostname(url.hostname) && !allowPrivate) {
    throw new GuardError("Local and internal hostnames cannot be inspected.");
  }

  // A literal IP skips DNS but still has to pass.
  if (isIP(url.hostname)) {
    if (!allowPrivate && isPrivateAddress(url.hostname)) throw new GuardError("Private and local addresses cannot be inspected.");
    return { url, addresses: [url.hostname] };
  }

  let records: Array<{ address: string }>;
  try {
    records = await lookup(url.hostname, { all: true, verbatim: true });
  } catch {
    throw new GuardError(`Could not resolve ${url.hostname}.`);
  }
  if (records.length === 0) throw new GuardError(`Could not resolve ${url.hostname}.`);

  for (const record of records) {
    if (!allowPrivate && isPrivateAddress(record.address)) {
      throw new GuardError(`${url.hostname} resolves to a private address.`);
    }
  }

  return { url, addresses: records.map((record) => record.address) };
}

export const MAX_REDIRECTS = 3;

/**
 * Follows redirects by hand so every hop is validated. `fetch` with
 * `redirect: "follow"` would skip the check on the second hop.
 */
export async function resolveRedirects(
  start: URL,
  follow: (url: URL) => Promise<Response>,
  options: GuardOptions = {},
): Promise<{ url: URL; response: Response }> {
  let current = start;

  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const response = await follow(current);
    if (response.status < 300 || response.status >= 400) return { url: current, response };

    const location = response.headers.get("location");
    if (!location) return { url: current, response };

    await response.body?.cancel();
    const next = new URL(location, current);
    const safe = await assertPublicUrl(next.toString(), options);
    current = safe.url;
  }

  throw new GuardError(`Too many redirects (limit ${MAX_REDIRECTS}).`);
}
