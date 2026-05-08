import { NextRequest, NextResponse } from "next/server";
import { addSubscriber } from "@/lib/pg";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null);
  const raw = body?.email;

  if (typeof raw !== "string") {
    return NextResponse.json({ error: "Email is required" }, { status: 400 });
  }

  const email = raw.trim().toLowerCase();
  if (email.length > 254 || !EMAIL_RE.test(email)) {
    return NextResponse.json(
      { error: "That doesn't look like an email." },
      { status: 400 }
    );
  }

  const { created } = await addSubscriber(email);
  return NextResponse.json({ ok: true, created });
}
