import { NextRequest, NextResponse } from "next/server";
import { requireAuth, isAuthError } from "@/lib/auth";
import {
  createFeed,
  listFeedsForUser,
  updateFeed,
  deleteFeed,
  getFeedForUser,
} from "@/lib/pg";
import type { MechanicalFilters, SemanticConfig } from "@/lib/types";

export async function GET(req: NextRequest) {
  const t0 = performance.now();
  const auth = await requireAuth(req);
  if (isAuthError(auth)) return auth;
  const tAuth = performance.now();

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
  const auth = await requireAuth(req);
  if (isAuthError(auth)) return auth;

  const { name } = await req.json().catch(() => ({ name: undefined }));
  const feed = await createFeed(auth.userId, name || "Untitled");
  return NextResponse.json({ feed });
}

export async function PATCH(req: NextRequest) {
  const auth = await requireAuth(req);
  if (isAuthError(auth)) return auth;

  const body = await req.json();
  const { id, name, description, mechanical_filters, semantic_config } =
    body as {
      id?: number;
      name?: string;
      description?: string;
      mechanical_filters?: MechanicalFilters;
      semantic_config?: SemanticConfig;
    };

  if (!id)
    return NextResponse.json({ error: "id required" }, { status: 400 });

  // Verify ownership
  const feed = await getFeedForUser(id, auth.userId);
  if (!feed)
    return NextResponse.json({ error: "Feed not found" }, { status: 404 });

  const updated = await updateFeed(id, {
    name,
    description,
    mechanical_filters,
    semantic_config,
  });
  return NextResponse.json({ feed: updated });
}

export async function DELETE(req: NextRequest) {
  const auth = await requireAuth(req);
  if (isAuthError(auth)) return auth;

  const { id } = await req.json();
  if (!id)
    return NextResponse.json({ error: "id required" }, { status: 400 });

  // Verify ownership
  const feed = await getFeedForUser(id, auth.userId);
  if (!feed)
    return NextResponse.json({ error: "Feed not found" }, { status: 404 });

  await deleteFeed(id);
  return NextResponse.json({ ok: true });
}
