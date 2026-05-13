import { NextRequest, NextResponse } from "next/server";
import { requireAuth, isAuthError } from "@/lib/auth";
import { listSearchRunsForUser } from "@/lib/pg";

export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  const auth = await requireAuth(req);
  if (isAuthError(auth)) return auth;

  const limitParam = Number(req.nextUrl.searchParams.get("limit") || "20");
  const limit = Number.isFinite(limitParam)
    ? Math.max(1, Math.min(100, Math.round(limitParam)))
    : 20;

  const rows = await listSearchRunsForUser(auth.userId, limit);
  return NextResponse.json({
    runs: rows.map((r) => ({
      id: r.id,
      query: r.query,
      vector_k: r.vector_k,
      rerank_k: r.rerank_k,
      rerank_enabled: r.rerank_enabled,
      ms_total: r.ms_total,
      created_at: r.created_at,
    })),
  });
}
