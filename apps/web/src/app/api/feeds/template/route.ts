import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import { ensureHomeFeed, getFeedForUser, updateFeed } from "@/lib/db/feeds";
import { TEMPLATE_FEED_CONFIG } from "@/lib/template-feed";

// Import the template starter config into one of the caller's feeds — the
// Home feed when no feedId is given. From a browser session:
//   fetch('/api/feeds/template', { method: 'POST' })
export async function POST(req: NextRequest) {
  const auth = await requireAuth();

  let feedId: number | undefined;
  try {
    const body = await req.json();
    if (typeof body?.feedId === "number") feedId = body.feedId;
  } catch {
    // No/invalid JSON body → apply to the Home feed.
  }

  const feed =
    feedId !== undefined
      ? await getFeedForUser(feedId, auth.userId)
      : await ensureHomeFeed(auth.userId);
  if (!feed)
    return NextResponse.json({ error: "Feed not found" }, { status: 404 });

  const updated = await updateFeed(feed.id, { ...TEMPLATE_FEED_CONFIG });
  return NextResponse.json({ feed: updated });
}
