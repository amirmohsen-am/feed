/**
 * POST /api/introspect/reset  { handle: string }
 * Deletes the local snapshot for this handle. Cached images stay (shared
 * cache, content-addressed).
 */

import { NextRequest, NextResponse } from "next/server";
import { deleteSnapshot } from "@/lib/introspect/storage";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  let body: { handle?: string };
  try {
    body = (await req.json()) as { handle?: string };
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const handle = (body.handle ?? "").trim();
  if (!handle) {
    return NextResponse.json({ error: "handle required" }, { status: 400 });
  }
  await deleteSnapshot(handle);
  return NextResponse.json({ ok: true });
}
