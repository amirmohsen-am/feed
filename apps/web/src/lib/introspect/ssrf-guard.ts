/**
 * SSRF guard for outbound fetches whose host/scheme are derived from
 * user-controllable input.
 *
 * The introspection pipeline resolves a caller-supplied Bluesky handle to a
 * DID, then reads that DID document's `serviceEndpoint` (the user's PDS) and
 * fetches it. `did:plc` documents are self-published, so the endpoint host and
 * scheme are fully attacker-controllable — without validation an attacker can
 * point the server at internal hosts (e.g. the cloud metadata endpoint at
 * 169.254.169.254, localhost services, RFC-1918 ranges).
 *
 * `assertPublicHttpsUrl` enforces https + a publicly-routable destination by
 * resolving DNS and checking every resolved address. This is the standard
 * pragmatic mitigation; a determined attacker could still attempt DNS
 * rebinding between this check and the actual connect, but the window is small
 * and the high-value targets (metadata/loopback/RFC-1918) are closed.
 */

import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

/**
 * True if `ip` is in a private, loopback, link-local, CGNAT, multicast, or
 * otherwise non-publicly-routable range. Unparseable input is treated as
 * unsafe (fail closed).
 */
function isPrivateIp(ip: string): boolean {
  const kind = isIP(ip);
  if (kind === 4) return isPrivateV4(ip);
  if (kind === 6) return isPrivateV6(ip);
  return true; // not a parseable IP → unsafe
}

function isPrivateV4(ip: string): boolean {
  const parts = ip.split(".").map((p) => Number(p));
  if (parts.length !== 4 || parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) {
    return true;
  }
  const [a, b] = parts;
  if (a === 0) return true; // 0.0.0.0/8 "this network"
  if (a === 10) return true; // 10.0.0.0/8 private
  if (a === 127) return true; // loopback
  if (a === 169 && b === 254) return true; // link-local incl. 169.254.169.254 metadata
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12 private
  if (a === 192 && b === 168) return true; // 192.168.0.0/16 private
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 CGNAT
  if (a >= 224) return true; // 224.0.0.0/4 multicast + 240.0.0.0/4 reserved
  return false;
}

function isPrivateV6(ip: string): boolean {
  const addr = ip.toLowerCase();
  if (addr === "::1" || addr === "::") return true; // loopback / unspecified
  // Link-local fe80::/10 → first hextet fe8x/fe9x/feax/febx.
  if (/^fe[89ab]/.test(addr)) return true;
  // Unique local fc00::/7 → fcxx / fdxx.
  if (/^f[cd]/.test(addr)) return true;
  // IPv4-mapped (::ffff:a.b.c.d) → validate the embedded v4 address.
  const mapped = addr.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isPrivateV4(mapped[1]);
  return false;
}

const ALLOWED_PROTOCOLS = new Set(["https:"]);

/**
 * Throws if `rawUrl` is not a public https URL whose host resolves only to
 * publicly-routable addresses. Call this before any fetch whose URL host/scheme
 * came from user-controllable input.
 */
export async function assertPublicHttpsUrl(rawUrl: string): Promise<void> {
  let u: URL;
  try {
    u = new URL(rawUrl);
  } catch {
    throw new Error("invalid endpoint URL");
  }
  if (!ALLOWED_PROTOCOLS.has(u.protocol)) {
    throw new Error(`endpoint protocol not allowed: ${u.protocol}`);
  }
  if (u.username || u.password) {
    throw new Error("credentials not allowed in endpoint URL");
  }
  const host = u.hostname; // IPv6 literals come back without brackets
  if (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".internal") ||
    host.endsWith(".local")
  ) {
    throw new Error("endpoint host not allowed");
  }
  // IP literal: validate directly without a DNS round-trip.
  if (isIP(host)) {
    if (isPrivateIp(host)) {
      throw new Error("endpoint resolves to a non-public address");
    }
    return;
  }
  // Hostname: resolve and validate every address it maps to.
  const addrs = await lookup(host, { all: true });
  if (addrs.length === 0) {
    throw new Error("endpoint host did not resolve");
  }
  for (const { address } of addrs) {
    if (isPrivateIp(address)) {
      throw new Error("endpoint resolves to a non-public address");
    }
  }
}
