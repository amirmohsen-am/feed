import { NextRequest, NextResponse } from "next/server";
import { requireAuth, isAuthError } from "@/lib/auth";
import {
  getFeedForUser,
  getBranchedFeedForPost,
  createBranchedFeed,
} from "@/lib/pg";
import { MAX_BRANCH_TOPICS } from "@/lib/branch";
import { jsonError } from "@/lib/api";

// Create a feed by branching off a post. The picked categories become the
// feed's subqueries; lineage (parent_feed_id + source_post_uri) is recorded.
// The rerank_prompt + a polished name are written by the seeded chat agent on
// the new feed's first turn (see /api/chat branch-init). See BRANCHING_PRD.md.
export async function POST(req: NextRequest) {
  const auth = await requireAuth();
  if (isAuthError(auth)) return auth;

  try {
    const body = await req.json();
    const { parentFeedId, sourcePostUri, subqueries, labels } = body as {
      parentFeedId?: number;
      sourcePostUri?: string;
      subqueries?: unknown;
      labels?: unknown;
    };

    if (!parentFeedId || typeof sourcePostUri !== "string" || !sourcePostUri) {
      return NextResponse.json(
        { error: "parentFeedId and sourcePostUri required" },
        { status: 400 }
      );
    }

    // Ownership check on the parent feed.
    const parent = await getFeedForUser(parentFeedId, auth.userId);
    if (!parent) {
      return NextResponse.json(
        { error: "Parent feed not found" },
        { status: 404 }
      );
    }

    // Re-branching the same post reuses its existing branch feed: the stable
    // feed id keeps the server-side preview cache warm (no pipeline rerun) and
    // the sidebar doesn't accumulate duplicates. The submitted subqueries are
    // ignored on reuse — the feed keeps the topics (+ any tuning) it already has.
    const existing = await getBranchedFeedForPost(
      auth.userId,
      parentFeedId,
      sourcePostUri
    );
    if (existing) {
      return NextResponse.json({ feed: existing, reused: true });
    }

    const cleanSubs = (Array.isArray(subqueries) ? subqueries : [])
      .filter((s): s is string => typeof s === "string")
      .map((s) => s.trim())
      .filter((s) => s.length > 0)
      .slice(0, MAX_BRANCH_TOPICS);
    if (cleanSubs.length === 0) {
      return NextResponse.json(
        { error: "At least one topic required" },
        { status: 400 }
      );
    }

    const cleanLabels = (Array.isArray(labels) ? labels : [])
      .filter((s): s is string => typeof s === "string")
      .map((s) => s.trim())
      .filter((s) => s.length > 0)
      .slice(0, MAX_BRANCH_TOPICS);

    // Placeholder name from the chosen labels; the seeded chat agent renames
    // it on its first turn once it reads the post's vibe.
    const placeholderName =
      cleanLabels.length > 0
        ? cleanLabels.slice(0, 2).join(" + ")
        : "New branch";

    const feed = await createBranchedFeed(auth.userId, {
      name: placeholderName,
      subqueries: cleanSubs,
      parentFeedId,
      sourcePostUri,
    });

    return NextResponse.json({ feed });
  } catch (e) {
    return jsonError(e, "feeds/branch");
  }
}
