import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import { recordSeen, clearSeen } from "@/lib/pg";

/**
 * Client-reported impressions from the curator preview. The workbench feed
 * tracks which posts actually reached the screen (IntersectionObserver + dwell,
 * mirroring the Bluesky client — see useSeenTracker.ts) and POSTs them here in
 * small batches.
 *
 * Records against the authenticated viewer (their own per-feed seen set), so
 * there is no ownership check: a user can only ever populate their own seen
 * rows. Best-effort and idempotent (recordSeen is ON CONFLICT DO NOTHING) — a
 * failure must never disrupt browsing, so we log and 200 rather than surface an
 * error toast on a background flush.
 */
export async function POST(req: NextRequest) {
  const auth = await requireAuth();

  let body: { feedId?: unknown; uris?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }

  const feedId = Number(body.feedId);
  if (!Number.isInteger(feedId) || feedId <= 0) {
    return NextResponse.json({ error: "feedId required" }, { status: 400 });
  }

  // Bound the batch and keep only well-formed at-uris. The tracker sends at
  // most a screenful at a time; the cap is a guard against a malformed client.
  const uris = Array.isArray(body.uris)
    ? body.uris
        .filter((u): u is string => typeof u === "string" && u.startsWith("at://"))
        .slice(0, 200)
    : [];
  if (uris.length === 0) return NextResponse.json({ ok: true, recorded: 0 });

  try {
    await recordSeen(auth.userId, feedId, uris);
    return NextResponse.json({ ok: true, recorded: uris.length });
  } catch (e) {
    console.warn(
      `[seen] record failed feedId=${feedId}:`,
      e instanceof Error ? e.message : String(e)
    );
    return NextResponse.json({ ok: false }, { status: 200 });
  }
}

/**
 * Clear the viewer's seen history so already-seen posts surface again. Scoped
 * to the authenticated viewer's own rows; an optional ?feedId limits it to one
 * feed (default: every feed for this user).
 */
export async function DELETE(req: NextRequest) {
  const auth = await requireAuth();

  const feedIdParam = req.nextUrl.searchParams.get("feedId");
  let feedId: number | undefined;
  if (feedIdParam !== null) {
    feedId = Number(feedIdParam);
    if (!Number.isInteger(feedId) || feedId <= 0) {
      return NextResponse.json({ error: "invalid feedId" }, { status: 400 });
    }
  }

  try {
    const deleted = await clearSeen(auth.userId, feedId);
    return NextResponse.json({ ok: true, deleted });
  } catch (e) {
    console.warn(
      "[seen] clear failed:",
      e instanceof Error ? e.message : String(e)
    );
    return NextResponse.json({ ok: false, error: "clear failed" }, { status: 500 });
  }
}
