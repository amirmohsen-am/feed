import { NextRequest, NextResponse } from "next/server";
import { requireAuth, isAuthError } from "@/lib/auth";
import {
  getFeedForUser,
  getUserByFirebaseUid,
  recordFeedback,
  type FeedbackCategory,
} from "@/lib/pg";
import { getSecret } from "@/lib/secrets";

const CATEGORIES: ReadonlySet<FeedbackCategory> = new Set([
  "bug",
  "idea",
  "feed_quality",
  "other",
]);

const MAX_BODY_CHARS = 4000;

const DEFAULT_RECIPIENTS = [
  "ohm.patel@hooglee.com",
  "amirmohsen.ahanchi@hooglee.com",
  "christian.neizonek@hooglee.com",
];

const DEFAULT_FROM = "Ripple Feed <feedback@hooglee.com>";

export async function POST(req: NextRequest) {
  const auth = await requireAuth(req);
  if (isAuthError(auth)) return auth;

  const body = await req.json().catch(() => null);
  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "invalid body" }, { status: 400 });
  }

  const category = body.category;
  if (typeof category !== "string" || !CATEGORIES.has(category as FeedbackCategory)) {
    return NextResponse.json(
      { error: "category must be one of bug | idea | feed_quality | other" },
      { status: 400 }
    );
  }

  const ratingRaw = Number(body.rating);
  if (!Number.isFinite(ratingRaw) || ratingRaw < 1 || ratingRaw > 10) {
    return NextResponse.json(
      { error: "rating must be an integer 1-10" },
      { status: 400 }
    );
  }
  const rating = Math.round(ratingRaw);

  let comment: string | null = null;
  if (typeof body.body === "string") {
    const trimmed = body.body.trim();
    if (trimmed.length > 0) {
      comment = trimmed.slice(0, MAX_BODY_CHARS);
    }
  }

  let feedId: number | null = null;
  if (body.feedId !== undefined && body.feedId !== null) {
    const n = Number(body.feedId);
    if (Number.isInteger(n) && n > 0) {
      const owned = await getFeedForUser(n, auth.userId);
      if (owned) feedId = n;
    }
  }

  const pageUrl =
    typeof body.pageUrl === "string" ? body.pageUrl.slice(0, 500) : null;
  const userAgent = req.headers.get("user-agent")?.slice(0, 500) ?? null;

  const row = await recordFeedback({
    userId: auth.userId,
    feedId,
    category: category as FeedbackCategory,
    rating,
    body: comment,
    pageUrl,
    userAgent,
  });

  // Fire-and-forget email. DB insert is the source of truth; an email
  // failure (unverified domain, network blip, missing API key) must not
  // fail the request.
  void sendFeedbackEmail({
    firebaseUid: auth.firebaseUid,
    feedId,
    category: category as FeedbackCategory,
    rating,
    body: comment,
    pageUrl,
    userAgent,
  }).catch((err) => {
    console.warn(
      "[feedback] email send failed:",
      err instanceof Error ? err.message : String(err)
    );
  });

  return NextResponse.json({ ok: true, id: String(row.id) });
}

async function sendFeedbackEmail(params: {
  firebaseUid: string;
  feedId: number | null;
  category: FeedbackCategory;
  rating: number;
  body: string | null;
  pageUrl: string | null;
  userAgent: string | null;
}) {
  let apiKey: string;
  try {
    apiKey = await getSecret("resend-api-key");
  } catch {
    // No key configured — skip silently.
    return;
  }

  const recipientsRaw = process.env.FEEDBACK_EMAIL_TO ?? DEFAULT_RECIPIENTS.join(",");
  const to = recipientsRaw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (to.length === 0) return;
  const from = process.env.FEEDBACK_EMAIL_FROM || DEFAULT_FROM;

  // Look up the user + feed for nicer subject/body.
  const user = await getUserByFirebaseUid(params.firebaseUid);
  const feed =
    params.feedId && user
      ? await getFeedForUser(params.feedId, user.id)
      : null;

  const who = user?.email || user?.name || params.firebaseUid;
  const categoryLabel = CATEGORY_LABEL[params.category];
  const subject = `[Ripple Feedback] ${categoryLabel} · ${params.rating}/10 from ${who}`;

  const lines = [
    `Category : ${categoryLabel}`,
    `Rating   : ${params.rating}/10`,
    `From     : ${who}${user?.name ? ` (${user.name})` : ""}`,
    feed ? `Feed     : ${feed.name} (#${feed.id})` : null,
    params.pageUrl ? `Page     : ${params.pageUrl}` : null,
    params.userAgent ? `Agent    : ${params.userAgent}` : null,
    "",
    params.body ?? "(no comment)",
  ].filter(Boolean) as string[];
  const text = lines.join("\n");

  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({ from, to, subject, text }),
  });

  if (!res.ok) {
    const errBody = await res.text().catch(() => "");
    throw new Error(`resend ${res.status}: ${errBody.slice(0, 200)}`);
  }
}

const CATEGORY_LABEL: Record<FeedbackCategory, string> = {
  bug: "Bug",
  idea: "Idea",
  feed_quality: "Feed quality",
  other: "Other",
};
