import { NextRequest, NextResponse } from "next/server";
import { requireAuth, isAuthError } from "@/lib/auth";
import {
  deleteRerankPrompt,
  getRerankPromptForUser,
  listRerankPromptVersions,
  renameRerankPrompt,
} from "@/lib/pg";

export const runtime = "nodejs";

export async function GET(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> }
) {
  const auth = await requireAuth(req);
  if (isAuthError(auth)) return auth;
  const { id } = await ctx.params;

  const prompt = await getRerankPromptForUser(id, auth.userId);
  if (!prompt) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const versions = await listRerankPromptVersions(id);
  return NextResponse.json({
    id: prompt.id,
    name: prompt.name,
    current_version: prompt.current_version,
    current_version_id: prompt.current_version_id,
    current_system_prompt: prompt.current_system_prompt,
    versions: versions.map((v) => ({
      id: v.id,
      version: v.version,
      system_prompt: v.system_prompt,
      created_at: v.created_at,
    })),
  });
}

export async function PATCH(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> }
) {
  const auth = await requireAuth(req);
  if (isAuthError(auth)) return auth;
  const { id } = await ctx.params;

  let body: { name?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!name) return NextResponse.json({ error: "name required" }, { status: 400 });

  await renameRerankPrompt(id, auth.userId, name);
  return NextResponse.json({ ok: true });
}

export async function DELETE(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> }
) {
  const auth = await requireAuth(req);
  if (isAuthError(auth)) return auth;
  const { id } = await ctx.params;
  await deleteRerankPrompt(id, auth.userId);
  return NextResponse.json({ ok: true });
}
