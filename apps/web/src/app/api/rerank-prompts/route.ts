import { NextRequest, NextResponse } from "next/server";
import { requireAuth, isAuthError } from "@/lib/auth";
import {
  createRerankPrompt,
  listRerankPromptsForUser,
} from "@/lib/pg";

export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  const auth = await requireAuth(req);
  if (isAuthError(auth)) return auth;
  const rows = await listRerankPromptsForUser(auth.userId);
  return NextResponse.json({
    prompts: rows.map((r) => ({
      id: r.id,
      name: r.name,
      current_version: r.current_version,
      current_system_prompt: r.current_system_prompt,
      updated_at: r.updated_at,
    })),
  });
}

export async function POST(req: NextRequest) {
  const auth = await requireAuth(req);
  if (isAuthError(auth)) return auth;

  let body: { name?: unknown; system_prompt?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const name = typeof body.name === "string" ? body.name.trim() : "";
  const systemPrompt =
    typeof body.system_prompt === "string" ? body.system_prompt : "";
  if (!name) return NextResponse.json({ error: "name required" }, { status: 400 });
  if (!systemPrompt.trim()) {
    return NextResponse.json({ error: "system_prompt required" }, { status: 400 });
  }

  const created = await createRerankPrompt({
    userId: auth.userId,
    name,
    systemPrompt,
  });
  return NextResponse.json({
    id: created.id,
    name: created.name,
    current_version: created.current_version,
    current_system_prompt: created.current_system_prompt,
  });
}
