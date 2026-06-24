import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import {
  createFeed,
  ensureHomeFeed,
  listFeedsForUser,
  updateFeed,
  deleteFeed,
  getFeedForUser,
} from "@/lib/pg";
import type { MechanicalFilters } from "@/lib/types";
import {
  MIN_CANDIDATE_BUDGET,
  MAX_CANDIDATE_BUDGET,
  normalizeRankingBias,
} from "@/lib/defaults";

export async function GET(req: NextRequest) {
  const t0 = performance.now();
  const auth = await requireAuth();
  const tAuth = performance.now();

  // Always ensure the home feed exists before listing.
  await ensureHomeFeed(auth.userId);
  const feeds = await listFeedsForUser(auth.userId);
  const tFeeds = performance.now();
  console.log(
    `[timing] GET /api/feeds auth=${(tAuth - t0).toFixed(0)}ms ` +
      `list=${(tFeeds - tAuth).toFixed(0)}ms ` +
      `total=${(tFeeds - t0).toFixed(0)}ms count=${feeds.length}`
  );
  return NextResponse.json({ feeds });
}

export async function POST(req: NextRequest) {
  const auth = await requireAuth();

  const { name } = await req.json().catch(() => ({ name: undefined }));
  const feed = await createFeed(auth.userId, name || "Untitled");
  return NextResponse.json({ feed });
}

export async function PATCH(req: NextRequest) {
  const auth = await requireAuth();

  const body = await req.json();
  const {
    id,
    name,
    mechanical_filters,
    subqueries,
    candidate_budget,
    rerank_prompt,
    rerank_model,
    rerank_thinking_enabled,
    engagement_weight,
    recency_weight,
    recency_halflife_h,
    seen_filter_enabled,
  } = body as {
    id?: number;
    name?: string;
    mechanical_filters?: MechanicalFilters;
    subqueries?: string[];
    candidate_budget?: number;
    rerank_prompt?: string;
    rerank_model?: string;
    rerank_thinking_enabled?: boolean;
    engagement_weight?: number;
    recency_weight?: number;
    recency_halflife_h?: number;
    seen_filter_enabled?: boolean;
  };

  if (!id)
    return NextResponse.json({ error: "id required" }, { status: 400 });

  // Verify ownership
  const feed = await getFeedForUser(id, auth.userId);
  if (!feed)
    return NextResponse.json({ error: "Feed not found" }, { status: 404 });

  // Home feed name is fixed.
  if (feed.is_home && name !== undefined)
    return NextResponse.json({ error: "Home feed name cannot be changed" }, { status: 400 });

  let cleanSubs: string[] | undefined;
  if (subqueries !== undefined) {
    cleanSubs = Array.isArray(subqueries)
      ? subqueries
          .filter((s): s is string => typeof s === "string")
          .map((s) => s.trim())
          .filter((s) => s.length > 0)
      : [];
  }

  let budget: number | undefined;
  if (candidate_budget !== undefined) {
    const n = Number(candidate_budget);
    if (Number.isFinite(n)) {
      budget = Math.max(MIN_CANDIDATE_BUDGET, Math.min(MAX_CANDIDATE_BUDGET, Math.round(n)));
    }
  }

  const updates: Parameters<typeof updateFeed>[1] = {
    name,
    mechanical_filters,
    subqueries: cleanSubs,
    candidate_budget: budget,
  };
  // Clamp + joint relevance-floor cap, shared with the curator agent path.
  const bias = normalizeRankingBias(
    { engagement_weight, recency_weight, recency_halflife_h },
    feed
  );
  if (bias.engagement_weight !== undefined)
    updates.engagement_weight = bias.engagement_weight;
  if (bias.recency_weight !== undefined)
    updates.recency_weight = bias.recency_weight;
  if (bias.recency_halflife_h !== undefined)
    updates.recency_halflife_h = bias.recency_halflife_h;
  if (typeof seen_filter_enabled === "boolean") {
    updates.seen_filter_enabled = seen_filter_enabled;
  }
  if (typeof name === "string") {
    const trimmed = name.trim();
    if (!trimmed) {
      return NextResponse.json({ error: "name cannot be empty" }, { status: 400 });
    }
    updates.name = trimmed.slice(0, 80);
  }
  if (typeof rerank_prompt === "string") {
    updates.rerank_prompt = rerank_prompt;
  }
  if (typeof rerank_model === "string" && rerank_model.length > 0) {
    updates.rerank_model = rerank_model;
  }
  if (typeof rerank_thinking_enabled === "boolean") {
    updates.rerank_thinking_enabled = rerank_thinking_enabled;
  }

  const updated = await updateFeed(id, updates);
  return NextResponse.json({ feed: updated });
}

export async function DELETE(req: NextRequest) {
  const auth = await requireAuth();

  const { id } = await req.json();
  if (!id)
    return NextResponse.json({ error: "id required" }, { status: 400 });

  // Verify ownership
  const feed = await getFeedForUser(id, auth.userId);
  if (!feed)
    return NextResponse.json({ error: "Feed not found" }, { status: 404 });

  if (feed.is_home)
    return NextResponse.json({ error: "Home feed cannot be deleted" }, { status: 400 });

  await deleteFeed(id);
  return NextResponse.json({ ok: true });
}
