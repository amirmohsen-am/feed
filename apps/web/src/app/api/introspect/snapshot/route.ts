/**
 * GET /api/introspect/snapshot?handle=...
 * Read-only access to the local snapshot. 404 if none exists.
 */

import { NextRequest, NextResponse } from "next/server";
import { readSnapshot } from "@/lib/introspect/storage";

export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  const handle = (req.nextUrl.searchParams.get("handle") ?? "").trim();
  if (!handle) {
    return NextResponse.json({ error: "handle required" }, { status: 400 });
  }
  const snap = await readSnapshot(handle);
  if (!snap) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  return NextResponse.json({ snapshot: snap });
}
