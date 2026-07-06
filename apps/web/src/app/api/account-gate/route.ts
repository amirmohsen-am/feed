import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import {
  getAccountGateStatus,
  markNudgesShown,
} from "@/lib/account-gate";

/** Current gate status for the session user. */
export async function GET() {
  const auth = await requireAuth();
  const gate = await getAccountGateStatus(auth.userId);
  return NextResponse.json({ gate });
}

const NUDGE_KEYS = new Set(["feeds", "posts", "refinements", "days"]);

/**
 * Record that nudges were displayed. Called at display time (not dismiss
 * time) so a reload can never re-trigger the same nudge.
 */
export async function POST(req: NextRequest) {
  const auth = await requireAuth();

  let body: { shown?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }

  const shown = Array.isArray(body.shown)
    ? body.shown.filter((k): k is string => typeof k === "string" && NUDGE_KEYS.has(k))
    : [];
  if (shown.length === 0) {
    return NextResponse.json({ error: "shown[] required" }, { status: 400 });
  }

  await markNudgesShown(auth.userId, shown);
  return NextResponse.json({ ok: true });
}
