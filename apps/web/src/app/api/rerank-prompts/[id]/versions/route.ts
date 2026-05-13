import { NextRequest, NextResponse } from "next/server";
import { requireAuth, isAuthError } from "@/lib/auth";
import { saveRerankPromptVersion } from "@/lib/pg";

export const runtime = "nodejs";

export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> }
) {
  const auth = await requireAuth(req);
  if (isAuthError(auth)) return auth;
  const { id } = await ctx.params;

  let body: { system_prompt?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const systemPrompt =
    typeof body.system_prompt === "string" ? body.system_prompt : "";
  if (!systemPrompt.trim()) {
    return NextResponse.json({ error: "system_prompt required" }, { status: 400 });
  }

  try {
    const v = await saveRerankPromptVersion({
      promptId: id,
      userId: auth.userId,
      systemPrompt,
    });
    return NextResponse.json({
      id: v.id,
      version: v.version,
      system_prompt: v.system_prompt,
      created_at: v.created_at,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg === "prompt not found") {
      return NextResponse.json({ error: msg }, { status: 404 });
    }
    throw e;
  }
}
