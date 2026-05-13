import { NextRequest, NextResponse } from "next/server";
import { requireAuth, isAuthError } from "@/lib/auth";
import { activateRerankPromptVersion } from "@/lib/pg";

export const runtime = "nodejs";

export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> }
) {
  const auth = await requireAuth(req);
  if (isAuthError(auth)) return auth;
  const { id } = await ctx.params;

  let body: { version_id?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const versionId = typeof body.version_id === "string" ? body.version_id : "";
  if (!versionId) {
    return NextResponse.json({ error: "version_id required" }, { status: 400 });
  }

  try {
    await activateRerankPromptVersion({
      promptId: id,
      userId: auth.userId,
      versionId,
    });
    return NextResponse.json({ ok: true });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg === "prompt or version not found") {
      return NextResponse.json({ error: msg }, { status: 404 });
    }
    throw e;
  }
}
