import { NextRequest, NextResponse } from "next/server";
import { requireAuth, isAuthError } from "@/lib/auth";
import { upsertUser, getUserByFirebaseUid } from "@/lib/pg";

export async function POST(req: NextRequest) {
  const auth = await requireAuth(req);
  if (isAuthError(auth)) return auth;

  const body = await req.json();

  const user = await upsertUser({
    firebaseUid: auth.firebaseUid,
    name: body.name || "User",
    email: body.email || "",
    photoUrl: body.photoUrl,
    blueskyHandle: body.blueskyHandle,
    blueskyDid: body.blueskyDid,
  });

  return NextResponse.json({ user });
}

export async function GET(req: NextRequest) {
  const auth = await requireAuth(req);
  if (isAuthError(auth)) return auth;

  const user = await getUserByFirebaseUid(auth.firebaseUid);
  if (!user) {
    return NextResponse.json({ error: "User not found" }, { status: 404 });
  }

  return NextResponse.json({ user });
}
