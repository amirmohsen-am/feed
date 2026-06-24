import { NextRequest, NextResponse } from "next/server";
import { parseFeedGeneratorUri } from "@/lib/feedgen";
import { verifyFeedRequesterDid } from "@/lib/feed-auth";
import { getPublishedFeed, getUserByBlueskyDid, recordSeen } from "@/lib/pg";

const SEND_INTERACTIONS_NSID = "app.bsky.feed.sendInteractions";
const INTERACTION_SEEN = "app.bsky.feed.defs#interactionSeen";

interface Interaction {
  item?: string;
  event?: string;
  feedContext?: string;
  reqId?: string;
}

/**
 * Receives the Bluesky client's feed-interaction batches and records
 * #interactionSeen events as per-viewer seen impressions. The AppView proxies
 * the client's call here via `atproto-proxy: <serviceDid>#bsky_fg` (the same
 * route used for getFeedSkeleton), attaching a service-auth JWT signed by the
 * requesting user. We verify it (audience = our service DID, method-bound to
 * sendInteractions) to identify the viewer.
 *
 * Mirrors the curator preview's /api/seen, but the client here is the real
 * Bluesky app, which already implements viewport + dwell seen tracking. The
 * empty 200 (OutputSchema is empty) is the lexicon's success response; we
 * fail-soft on everything so a feedback batch never errors the client.
 *
 * Only acted on when the feed has seen filtering enabled — a feed accumulates
 * seen state only while the owner has opted in, matching getFeedSkeletonPage.
 */
export async function POST(req: NextRequest) {
  let body: { feed?: string; interactions?: Interaction[] };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({}, { status: 200 });
  }

  const interactions = Array.isArray(body.interactions) ? body.interactions : [];
  if (interactions.length === 0) return NextResponse.json({});

  // Resolve the feed the interactions belong to. Without it we can't scope the
  // per-feed seen set, so there's nothing to record.
  const parsed = body.feed ? parseFeedGeneratorUri(body.feed) : null;
  const feed = parsed
    ? await getPublishedFeed(parsed.rkey, parsed.publisherDid)
    : null;
  if (!feed || !feed.seen_filter_enabled) return NextResponse.json({});

  // Identify the viewer from the service-auth JWT.
  const did = await verifyFeedRequesterDid(
    req.headers.get("authorization"),
    SEND_INTERACTIONS_NSID
  );
  if (!did) return NextResponse.json({});
  const user = await getUserByBlueskyDid(did);
  if (!user) return NextResponse.json({});

  // Dedup the seen at-uris in this batch.
  const seenUris = Array.from(
    new Set(
      interactions
        .filter((i) => i.event === INTERACTION_SEEN)
        .map((i) => i.item)
        .filter((u): u is string => typeof u === "string" && u.startsWith("at://"))
    )
  );
  if (seenUris.length === 0) return NextResponse.json({});

  try {
    await recordSeen(user.id, feed.id, seenUris);
  } catch (e) {
    console.warn(
      `[sendInteractions] seen record failed feedId=${feed.id}:`,
      e instanceof Error ? e.message : String(e)
    );
  }
  return NextResponse.json({});
}
