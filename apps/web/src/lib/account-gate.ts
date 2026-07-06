import { NextResponse } from "next/server";
import { query } from "./db/connection";

/**
 * Account gate: anonymous users get recurring "connect Bluesky" nudges as
 * they use the app, and after GATE_WALL_NUDGES nudges have been shown, the
 * NEXT threshold crossing raises a hard wall (non-dismissible modal +
 * server-side 403s via gateGuard).
 *
 * Nudges are interval-based: every GATE_NUDGE.feeds feeds created, every
 * GATE_NUDGE.posts posts seen, etc., each metric independently. Usage is
 * derived live from existing tables (no counters to drift); the persisted
 * state is users.gate_nudges_shown:
 *
 *   { "feeds": 3, "posts": 200, ..., "count": 2, "wall": "<iso ts>" }
 *
 * Per-metric values are the usage level at which that metric last nudged
 * (so reloads never re-trigger, but the next interval does). "count" is
 * total nudge popups shown. "wall" is sticky: once written the wall never
 * reopens, even if pruning shrinks derived counts.
 */

function envInt(name: string, fallback: number): number {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

// A nudge fires each time a metric crosses another multiple of its interval.
export const GATE_NUDGE = {
  feeds: envInt("GATE_NUDGE_FEEDS", 3), // non-home feeds created
  posts: envInt("GATE_NUDGE_POSTS", 100), // seen_posts rows
  refinements: envInt("GATE_NUDGE_REFINEMENTS", 10), // user chat messages
  days: envInt("GATE_NUDGE_DAYS", 2), // calendar days of use, day 1 = first visit
};

// After this many nudges have been shown, the next crossing walls instead.
export const GATE_WALL_NUDGES = envInt("GATE_WALL_NUDGES", 3);

export const GATE_DISABLED = process.env.ACCOUNT_GATE_DISABLED === "1";

export type GateMetric = "feeds" | "posts" | "refinements" | "days";
export type GatePhase = "linked" | "free" | "nudge" | "wall";

export interface GateStatus {
  phase: GatePhase;
  usage: Record<GateMetric, number>;
  /** Metrics that crossed a new interval milestone since their last nudge. */
  pendingNudges: GateMetric[];
  /** Total nudge popups shown so far. */
  nudgesShown: number;
}

const METRICS: GateMetric[] = ["feeds", "posts", "refinements", "days"];

const LINKED_STATUS: GateStatus = {
  phase: "linked",
  usage: { feeds: 0, posts: 0, refinements: 0, days: 0 },
  pendingNudges: [],
  nudgesShown: 0,
};

interface GateRow {
  usage: Record<GateMetric, number>;
  shown: Record<string, unknown>;
  linked: boolean;
}

async function readGateRow(userId: string): Promise<GateRow | null> {
  const res = await query(
    `SELECT u.created_at,
            u.bluesky_did IS NOT NULL AS linked,
            u.gate_nudges_shown,
            (SELECT count(*)::int FROM feeds f
              WHERE f.user_id = u.id AND f.is_home = false) AS feeds_count,
            (SELECT count(*)::int FROM seen_posts s
              WHERE s.user_id = u.id) AS posts_seen,
            (SELECT count(*)::int FROM chat_messages m
              JOIN feeds f2 ON f2.id = m.feed_id
              WHERE f2.user_id = u.id AND m.role = 'user') AS refinements
       FROM users u WHERE u.id = $1`,
    [userId]
  );
  const row = res.rows[0];
  if (!row) return null;
  const days =
    Math.floor(
      (Date.now() - new Date(row.created_at).getTime()) / 86_400_000
    ) + 1;
  return {
    usage: {
      feeds: row.feeds_count,
      posts: row.posts_seen,
      refinements: row.refinements,
      days,
    },
    shown: row.gate_nudges_shown ?? {},
    linked: row.linked,
  };
}

/** Usage level at which `metric` last nudged (0 = never). */
function lastNudgedAt(shown: Record<string, unknown>, metric: GateMetric): number {
  const v = shown[metric];
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0;
}

function nudgeCount(shown: Record<string, unknown>): number {
  const v = shown["count"];
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.floor(v) : 0;
}

/** Metrics that crossed a new interval multiple since their last nudge. */
function pendingMetrics(
  usage: Record<GateMetric, number>,
  shown: Record<string, unknown>
): GateMetric[] {
  return METRICS.filter((m) => {
    const milestone = Math.floor(usage[m] / GATE_NUDGE[m]);
    const lastMilestone = Math.floor(lastNudgedAt(shown, m) / GATE_NUDGE[m]);
    return milestone >= 1 && milestone > lastMilestone;
  });
}

export async function getAccountGateStatus(
  userId: string
): Promise<GateStatus> {
  if (GATE_DISABLED) return LINKED_STATUS;

  const row = await readGateRow(userId);
  if (!row || row.linked) return LINKED_STATUS;
  const { usage, shown } = row;

  const shownCount = nudgeCount(shown);
  const pending = pendingMetrics(usage, shown);

  // Sticky wall, or: the nudge allowance is used up and another threshold
  // crossed — that crossing becomes the wall instead of a fourth nudge.
  const atWall =
    "wall" in shown || (shownCount >= GATE_WALL_NUDGES && pending.length > 0);
  if (atWall) {
    if (!("wall" in shown)) {
      await query(
        `UPDATE users
            SET gate_nudges_shown =
                  COALESCE(gate_nudges_shown, '{}'::jsonb) || $2::jsonb,
                updated_at = now()
          WHERE id = $1 AND NOT (COALESCE(gate_nudges_shown, '{}'::jsonb) ? 'wall')`,
        [userId, JSON.stringify({ wall: new Date().toISOString() })]
      );
    }
    return { phase: "wall", usage, pendingNudges: [], nudgesShown: shownCount };
  }

  if (pending.length > 0) {
    return { phase: "nudge", usage, pendingNudges: pending, nudgesShown: shownCount };
  }

  return { phase: "free", usage, pendingNudges: [], nudgesShown: shownCount };
}

/**
 * Record that one nudge popup was displayed for `keys`: stamps each metric's
 * current usage level as its last-nudged mark and increments the total popup
 * count by one (a popup covering several metrics still counts once).
 */
export async function markNudgesShown(
  userId: string,
  keys: string[]
): Promise<void> {
  const metrics = keys.filter((k): k is GateMetric =>
    (METRICS as string[]).includes(k)
  );
  if (metrics.length === 0) return;

  const row = await readGateRow(userId);
  if (!row) return;

  const patch: Record<string, number> = {
    count: nudgeCount(row.shown) + 1,
  };
  for (const m of metrics) patch[m] = row.usage[m];

  await query(
    `UPDATE users
        SET gate_nudges_shown =
              COALESCE(gate_nudges_shown, '{}'::jsonb) || $2::jsonb,
            updated_at = now()
      WHERE id = $1`,
    [userId, JSON.stringify(patch)]
  );
}

/**
 * Server-side wall enforcement for compute/mutating routes. Returns a 403
 * response when the user is walled, else null. Usage:
 *   const walled = await gateGuard(auth.userId);
 *   if (walled) return walled;
 */
export async function gateGuard(
  userId: string
): Promise<NextResponse | null> {
  const status = await getAccountGateStatus(userId);
  if (status.phase !== "wall") return null;
  return NextResponse.json(
    {
      error: "Connect a Bluesky account to keep using the curator.",
      code: "account_wall",
    },
    { status: 403 }
  );
}
