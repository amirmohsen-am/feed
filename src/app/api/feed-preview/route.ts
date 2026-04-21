import { NextResponse } from "next/server";
import { getDb, getPreferences } from "@/lib/db";

export async function GET() {
  const db = getDb();

  const posts = db
    .prepare(
      `SELECT uri, author_did, text, score, indexed_at
       FROM posts ORDER BY score DESC, indexed_at DESC LIMIT 50`
    )
    .all() as {
    uri: string;
    author_did: string;
    text: string;
    score: number;
    indexed_at: string;
  }[];

  const count = db.prepare("SELECT COUNT(*) as n FROM posts").get() as {
    n: number;
  };

  return NextResponse.json({
    total_stored: count.n,
    preferences: getPreferences(),
    posts,
  });
}
