/**
 * Deterministic engagement statistics (design §1.2).
 *
 * IMPORTANT: this output is for the UI ONLY. The LLM never sees these
 * numbers — the model judges signal weighting from the engagement records
 * themselves. Stats exist purely so the user can see the shape of their
 * own activity alongside the prose profile.
 */

import type { Engagement, SignalType, Stats } from "./types";

const SIGNAL_ORDER: SignalType[] = ["like", "repost", "quote", "post", "reply"];

const RECENT_WINDOW_DAYS = 30;
const TOP_ACCOUNT_LIMIT = 5;

/** True for signals where "the subject author" is meaningful for top-accounts. */
function targetsThirdParty(t: SignalType): boolean {
  return t === "like" || t === "repost" || t === "quote" || t === "reply";
}

function wordCount(text: string | null | undefined): number {
  if (!text) return 0;
  const t = text.trim();
  if (!t) return 0;
  return t.split(/\s+/).length;
}

export function computeStats(engagements: Engagement[]): Stats {
  if (engagements.length === 0) {
    return emptyStats();
  }

  const byType: Record<SignalType, number> = {
    like: 0,
    repost: 0,
    quote: 0,
    post: 0,
    reply: 0,
  };
  const withImages: Record<SignalType, number> = {
    like: 0,
    repost: 0,
    quote: 0,
    post: 0,
    reply: 0,
  };
  const withLinks: Record<SignalType, number> = {
    like: 0,
    repost: 0,
    quote: 0,
    post: 0,
    reply: 0,
  };

  let unavailable = 0;
  let quoteWords = 0;
  let quoteCount = 0;
  let replyWords = 0;
  let replyCount = 0;

  let earliest = engagements[0].ts;
  let latest = engagements[0].ts;

  // Per-account roll-up (for top engaged-with accounts). The "engaged-with"
  // account is the subject author for likes/reposts/quotes; for replies it's
  // the user being replied to (subject.author of the replying record IS the
  // user themselves, so we follow the recursive replyingTo instead).
  const perAccount = new Map<
    string,
    { total: number; byType: Partial<Record<SignalType, number>> }
  >();

  function bumpAccount(handle: string, type: SignalType) {
    if (!handle || handle === "@unknown") return;
    let row = perAccount.get(handle);
    if (!row) {
      row = { total: 0, byType: {} };
      perAccount.set(handle, row);
    }
    row.total += 1;
    row.byType[type] = (row.byType[type] ?? 0) + 1;
  }

  for (const e of engagements) {
    byType[e.type] += 1;
    if (e.ts < earliest) earliest = e.ts;
    if (e.ts > latest) latest = e.ts;
    if (e.subject.unavailable) unavailable += 1;

    const hasImage =
      (e.subject.imageCids?.length ?? 0) > 0 ||
      (e.subject.quoting?.imageCids?.length ?? 0) > 0 ||
      (e.subject.replyingTo?.imageCids?.length ?? 0) > 0;
    const hasLink =
      !!e.subject.linkCard ||
      !!e.subject.quoting?.linkCard ||
      !!e.subject.replyingTo?.linkCard;
    if (hasImage) withImages[e.type] += 1;
    if (hasLink) withLinks[e.type] += 1;

    if (e.type === "quote") {
      quoteCount += 1;
      quoteWords += wordCount(e.userText);
    }
    if (e.type === "reply") {
      replyCount += 1;
      replyWords += wordCount(e.userText);
    }

    if (targetsThirdParty(e.type)) {
      // The engaged-with account is the third party — not the user themselves.
      //   like / repost: subject.author IS the third-party (subject is the
      //                  external post the user touched).
      //   quote:         subject is the user's own quoting post; the third
      //                  party is the quoted record's author.
      //   reply:         subject is the user's own reply; the third party is
      //                  the replied-to record's author.
      const target =
        e.type === "reply"
          ? (e.subject.replyingTo?.author ?? "")
          : e.type === "quote"
            ? (e.subject.quoting?.author ?? "")
            : e.subject.author;
      bumpAccount(target, e.type);
    }
  }

  const total = engagements.length;
  const earliestMs = Date.parse(earliest);
  const latestMs = Date.parse(latest);
  const spanMs = Math.max(latestMs - earliestMs, 1);
  const spanDays = Math.max(1, Math.round(spanMs / 86_400_000));
  const avgPerDay = round1(total / spanDays);

  const byTypeWithPct = {} as Record<
    SignalType,
    { count: number; pct: number }
  >;
  for (const t of SIGNAL_ORDER) {
    byTypeWithPct[t] = {
      count: byType[t],
      pct: round1((byType[t] / total) * 100),
    };
  }

  const imagePctByType: Partial<Record<SignalType, number>> = {};
  const linkCardPctByType: Partial<Record<SignalType, number>> = {};
  for (const t of SIGNAL_ORDER) {
    if (byType[t] > 0) {
      imagePctByType[t] = round1((withImages[t] / byType[t]) * 100);
      linkCardPctByType[t] = round1((withLinks[t] / byType[t]) * 100);
    }
  }

  // ── Recency: last RECENT_WINDOW_DAYS vs prior trailing average ────────
  const nowMs = latestMs;
  const windowMs = RECENT_WINDOW_DAYS * 86_400_000;
  const recentCount = engagements.filter(
    (e) => nowMs - Date.parse(e.ts) <= windowMs
  ).length;
  const olderTotal = total - recentCount;
  // Prior trailing average: take the rest of the span, project onto
  // RECENT_WINDOW_DAYS-sized windows.
  const olderSpanDays = Math.max(spanDays - RECENT_WINDOW_DAYS, 1);
  const priorAvg30d =
    olderSpanDays >= 1 ? (olderTotal / olderSpanDays) * RECENT_WINDOW_DAYS : 0;
  const pctChange =
    priorAvg30d > 0
      ? round1(((recentCount - priorAvg30d) / priorAvg30d) * 100)
      : null;

  // ── Top engaged-with accounts ─────────────────────────────────────────
  const topAccounts = Array.from(perAccount.entries())
    .map(([handle, v]) => ({ handle, total: v.total, byType: v.byType }))
    .sort((a, b) => b.total - a.total)
    .slice(0, TOP_ACCOUNT_LIMIT);

  // ── Ratios ────────────────────────────────────────────────────────────
  const repostToLike =
    byType.like > 0 ? round2(byType.repost / byType.like) : null;
  const quoteToRepost =
    byType.repost > 0 ? round2(byType.quote / byType.repost) : null;
  const own = byType.post + byType.quote + byType.reply;
  const consumed = byType.like + byType.repost;
  const ownToConsumed = consumed > 0 ? round2(own / consumed) : null;

  return {
    total,
    rangeStart: earliest,
    rangeEnd: latest,
    spanDays,
    avgPerDay,
    byType: byTypeWithPct,
    imagePctByType,
    linkCardPctByType,
    avgQuoteWords: quoteCount > 0 ? round1(quoteWords / quoteCount) : 0,
    avgReplyWords: replyCount > 0 ? round1(replyWords / replyCount) : 0,
    ratios: { repostToLike, quoteToRepost, ownToConsumed },
    recent30d: { count: recentCount, priorAvg30d: round1(priorAvg30d), pctChange },
    topAccounts,
    unavailableCount: unavailable,
  };
}

function emptyStats(): Stats {
  return {
    total: 0,
    rangeStart: "",
    rangeEnd: "",
    spanDays: 0,
    avgPerDay: 0,
    byType: {
      like: { count: 0, pct: 0 },
      repost: { count: 0, pct: 0 },
      quote: { count: 0, pct: 0 },
      post: { count: 0, pct: 0 },
      reply: { count: 0, pct: 0 },
    },
    imagePctByType: {},
    linkCardPctByType: {},
    avgQuoteWords: 0,
    avgReplyWords: 0,
    ratios: { repostToLike: null, quoteToRepost: null, ownToConsumed: null },
    recent30d: { count: 0, priorAvg30d: 0, pctChange: null },
    topAccounts: [],
    unavailableCount: 0,
  };
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}
function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
