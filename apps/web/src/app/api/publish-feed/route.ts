import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import { createSession, publishFeedGenerator } from "@/lib/bsky-agent";
import {
  feedGeneratorRkey,
  getFeedgenServiceDid,
  isFeedgenPublishable,
  feedgenPublishBlockedMessage,
} from "@/lib/feedgen";
import { getFeedForUser, getUserById, updateFeed, warmFeedSkeletonCache } from "@/lib/pg";
import { restoreBskySession } from "@/lib/bsky-oauth";

/**
 * POST /api/publish-feed
 * Body: { feedId: number, appPassword?: string }
 *
 * Creates (or updates) an app.bsky.feed.generator record on the user's repo
 * pointing at this service's did:web. Tries OAuth first, then app password.
 */
export async function POST(req: NextRequest) {
  const auth = await requireAuth();

  const body = await req.json().catch(() => ({}));
  const { feedId, appPassword } = body as {
    feedId?: number;
    appPassword?: string;
  };

  if (!feedId || !Number.isFinite(feedId)) {
    return NextResponse.json({ error: "feedId required" }, { status: 400 });
  }

  const feed = await getFeedForUser(feedId, auth.userId);
  if (!feed) {
    return NextResponse.json({ error: "Feed not found" }, { status: 404 });
  }
  if (feed.subqueries.length === 0) {
    return NextResponse.json(
      { error: "Configure your feed before publishing" },
      { status: 400 }
    );
  }

  if (!isFeedgenPublishable()) {
    return NextResponse.json(
      { error: feedgenPublishBlockedMessage(), code: "local_feedgen" },
      { status: 400 }
    );
  }

  const user = await getUserById(auth.userId);
  if (!user?.bluesky_did && !user?.bluesky_handle) {
    return NextResponse.json(
      { error: "Connect your Bluesky account first." },
      { status: 403 }
    );
  }

  const serviceDid = getFeedgenServiceDid();
  const rkey = feed.published_rkey ?? feedGeneratorRkey(feed.id);
  const displayName = (feed.name || "My Feed").slice(0, 24);
  const description =
    feed.subqueries.length > 0
      ? `Curated feed: ${feed.subqueries.slice(0, 3).join(", ")}`
      : "AI-curated feed";

  try {
    let publisherDid: string | null = null;

    if (user.bluesky_did) {
      try {
        const oauthSession = await restoreBskySession(user.bluesky_did);
        const res = await oauthSession.fetchHandler(
          "/xrpc/com.atproto.repo.putRecord",
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              repo: user.bluesky_did,
              collection: "app.bsky.feed.generator",
              rkey,
              record: {
                $type: "app.bsky.feed.generator",
                did: serviceDid,
                displayName,
                description: description.slice(0, 300),
                createdAt: new Date().toISOString(),
              },
            }),
          }
        );
        if (!res.ok) {
          throw new Error(`OAuth putRecord failed: ${res.status} ${await res.text()}`);
        }
        publisherDid = user.bluesky_did;
      } catch (oauthErr) {
        console.warn(
          "[publish-feed] OAuth failed:",
          oauthErr instanceof Error ? oauthErr.message : oauthErr
        );
      }
    }

    if (!publisherDid) {
      const password =
        (typeof appPassword === "string" && appPassword.trim()) ||
        user.bsky_app_password;
      const handle = user.bluesky_handle;
      if (!handle || !password) {
        return NextResponse.json(
          {
            error:
              "Bluesky authorization required. Click “Authorize Bluesky” in the publish dialog, or enter an app password.",
            code: "reauth_required",
          },
          { status: 403 }
        );
      }
      const session = await createSession(handle, password);
      publisherDid = session.did;
      await publishFeedGenerator(session, {
        rkey,
        serviceDid,
        displayName,
        description,
      });
    }

    await updateFeed(feedId, { published_rkey: rkey, is_active: true });

    // Warm skeleton cache before Bluesky's first fetch (avoids timeout on cold rerank).
    try {
      const warmed = await warmFeedSkeletonCache(feedId);
      console.log(
        `[publish-feed] skeleton cache warmed feedId=${feedId} posts=${warmed}`
      );
    } catch (e) {
      console.warn(
        "[publish-feed] skeleton cache warm failed:",
        e instanceof Error ? e.message : e
      );
    }

    const feedUri = `at://${publisherDid}/app.bsky.feed.generator/${rkey}`;

    return NextResponse.json({
      ok: true,
      feedUri,
      message: `Feed published! Open Bluesky and search for "${displayName}" under Feeds.`,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Publish failed";
    console.warn("[publish-feed] error:", msg);
    return NextResponse.json({ error: msg }, { status: 401 });
  }
}
