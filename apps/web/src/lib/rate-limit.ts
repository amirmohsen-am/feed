/**
 * In-memory per-IP rate limiter for the paid (LLM / embedding / Hive) routes.
 *
 * Why in-memory and not Postgres/Redis: `feed-web` runs pinned at
 * minScale=maxScale=1, so there is exactly one Node process. A module-level Map
 * is therefore a *global* counter shared across all concurrent requests — no
 * shared store is needed. This is correct ONLY while the service stays at a
 * single instance; if maxScale is ever raised above 1 the limit multiplies
 * per-instance and this must move to shared state (Cloud SQL / Redis) or
 * Cloud Armor at an external load balancer.
 *
 * State resets on each deploy/restart — fine for short rate-limit windows. The
 * provider-side spend caps (Anthropic spend limit, GCP budget, Vertex quota,
 * Hive cap) remain the authoritative bill ceiling; this limiter only blunts
 * casual scripted abuse before it reaches those caps.
 */

import { NextRequest, NextResponse } from "next/server";

export interface RateRule {
  /** Window length in milliseconds. */
  windowMs: number;
  /** Max requests permitted per key within the window. */
  max: number;
}

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** Default tier for single-LLM-call routes (chat, search, branch, etc.). */
export const LLM_RULES: RateRule[] = [
  { windowMs: MINUTE, max: 200 },
  { windowMs: DAY, max: 3000 },
];

/** Stricter tier for the multi-call / heavy-fanout introspect routes. */
export const EXPENSIVE_RULES: RateRule[] = [
  { windowMs: MINUTE, max: 60 },
  { windowMs: HOUR, max: 400 },
  { windowMs: DAY, max: 800 },
];

/**
 * Tier for the Hive AI-label route. ai-label fans out one request per
 * image-bearing post on every feed load, so a single normal view can fire
 * ~20-30 requests in a burst — far above LLM_RULES. The per-image Hive cache
 * (ai_image_labels) makes the vast majority of these free cache-hits; this
 * higher ceiling keeps normal browsing working while still bounding the
 * cold-cache / attacker case (unique URLs → real Hive spend).
 */
export const HIVE_RULES: RateRule[] = [
  { windowMs: MINUTE, max: 1000 },
  { windowMs: HOUR, max: 10000 },
  { windowMs: DAY, max: 40000 },
];

/**
 * IPs that bypass the limiter entirely — for developers/QA testing the public
 * demo from a shared office/VPN egress (which would otherwise share one bucket
 * and exhaust it). Seeded with our office IP; extend via the
 * `RATE_LIMIT_ALLOW_IPS` env var (comma-separated). Set `RATE_LIMIT_DISABLED=1`
 * to turn the limiter off entirely (e.g. on a dev/staging deploy).
 */
const DEFAULT_ALLOWLIST = ["64.125.53.231"];
const ALLOWLISTED_IPS = new Set<string>([
  ...DEFAULT_ALLOWLIST,
  ...(process.env.RATE_LIMIT_ALLOW_IPS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
]);

interface WindowState {
  start: number;
  count: number;
}
interface Entry {
  windows: WindowState[];
  lastTouch: number;
}

const store = new Map<string, Entry>();
let lastSweep = 0;
const SWEEP_INTERVAL = 5 * MINUTE;
// An entry is only useful while at least one of its windows is still open;
// the longest window we ever configure is a day, so idle-evict past that.
const MAX_IDLE = DAY;

function sweep(now: number): void {
  if (now - lastSweep < SWEEP_INTERVAL) return;
  lastSweep = now;
  for (const [key, entry] of store) {
    if (now - entry.lastTouch > MAX_IDLE) store.delete(key);
  }
}

export interface RateLimitResult {
  ok: boolean;
  /** Seconds until the most-constraining window frees up (0 when ok). */
  retryAfterSec: number;
}

/**
 * Fixed-window counter check for `key` against every rule. Does NOT consume
 * quota when any rule is already at its limit, so a rejection by the daily
 * window doesn't also burn the minute window.
 */
export function rateLimit(
  key: string,
  rules: RateRule[],
  now: number = Date.now()
): RateLimitResult {
  sweep(now);
  let entry = store.get(key);
  if (!entry) {
    entry = { windows: rules.map(() => ({ start: now, count: 0 })), lastTouch: now };
    store.set(key, entry);
  }
  entry.lastTouch = now;

  // Roll over any elapsed windows first.
  for (let i = 0; i < rules.length; i++) {
    const w = entry.windows[i];
    if (now - w.start >= rules[i].windowMs) {
      w.start = now;
      w.count = 0;
    }
  }
  // Reject if any rule is at capacity; report the longest wait.
  let retryAfterMs = 0;
  for (let i = 0; i < rules.length; i++) {
    if (entry.windows[i].count >= rules[i].max) {
      retryAfterMs = Math.max(retryAfterMs, rules[i].windowMs - (now - entry.windows[i].start));
    }
  }
  if (retryAfterMs > 0) {
    return { ok: false, retryAfterSec: Math.max(1, Math.ceil(retryAfterMs / SECOND)) };
  }
  // All clear — consume one unit from every window.
  for (const w of entry.windows) w.count++;
  return { ok: true, retryAfterSec: 0 };
}

/**
 * Best-effort client IP from the forwarded chain.
 *
 * On direct *.run.app access the Google front-end appends the real peer IP as
 * the LAST entry of X-Forwarded-For, so taking the last entry (not the first)
 * defeats a client that spoofs its own X-Forwarded-For header. If this service
 * is later fronted by an external HTTPS load balancer, the trusted-proxy depth
 * changes and this must be revisited.
 */
export function clientIp(req: NextRequest): string {
  const xff = req.headers.get("x-forwarded-for");
  if (xff) {
    const parts = xff.split(",").map((s) => s.trim()).filter(Boolean);
    if (parts.length > 0) return parts[parts.length - 1];
  }
  return "unknown";
}

/**
 * Enforce a rate-limit tier for `bucket` keyed on the caller's IP. Returns a
 * 429 NextResponse when over the limit, or null to proceed. Usage:
 *
 *   const limited = enforceRateLimit(req, "chat", LLM_RULES);
 *   if (limited) return limited;
 */
export function enforceRateLimit(
  req: NextRequest,
  bucket: string,
  rules: RateRule[] = LLM_RULES
): NextResponse | null {
  if (process.env.RATE_LIMIT_DISABLED === "1") return null;
  const ip = clientIp(req);
  if (ALLOWLISTED_IPS.has(ip)) return null;
  const result = rateLimit(`${bucket}:${ip}`, rules);
  if (result.ok) return null;
  return NextResponse.json(
    { error: "Rate limit exceeded — please slow down and try again shortly." },
    { status: 429, headers: { "Retry-After": String(result.retryAfterSec) } }
  );
}
