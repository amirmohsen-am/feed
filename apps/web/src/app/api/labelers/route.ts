/**
 * GET /api/labelers
 *
 * Public. Returns the labeler directory sorted by on-protocol like count
 * (most-liked first). Reads the discovered DID set from bsky-db and enriches it
 * from the AppView on demand (cached with a TTL) — see lib/labelers.ts.
 */

import { NextResponse } from "next/server";
import { getLabelers } from "@/lib/labelers";

export const dynamic = "force-dynamic";

export async function GET() {
  const labelers = await getLabelers();
  return NextResponse.json({ labelers });
}
