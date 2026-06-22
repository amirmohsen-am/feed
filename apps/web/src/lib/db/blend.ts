/**
 * Deterministic ranking-bias blend.
 *
 * Applied at bake time, AFTER the LLM reranker, to re-sort the kept candidate
 * pool. The reranker decides MEMBERSHIP + editorial relevance (its 0–100
 * score); this blend decides FINAL ORDER by layering on two signals the LLM
 * structurally can't judge well (it sees partial engagement counts and no
 * timestamp at all):
 *
 *     final = w_q·(rerank/100) + w_e·engagement + w_r·recency
 *     w_q  = 1 - w_e - w_r        (clamped ≥ 0 — a misconfigured feed with
 *                                  w_e + w_r > 1 collapses to pure bias, never
 *                                  a negative relevance term)
 *
 * Both engagement and recency are normalized to [0, 1] so the weights are
 * directly comparable. Engagement is log-compressed (heavy-tailed raw counts);
 * recency is an exponential half-life decay.
 *
 * Bake-time, not serve-time: between 6-hourly refreshes the candidate set is
 * frozen and the recency ordering is time-invariant, so recomputing at serve
 * time would only scale the recency term by a uniform constant — a bounded,
 * second-order drift not worth the per-request cost. Refresh cadence (≤
 * half-life) is the real freshness lever.
 */

import { ENGAGEMENT_REF } from "../defaults";

export interface BlendWeights {
  engagementWeight: number;
  recencyWeight: number;
  recencyHalflifeH: number;
}

function clamp01(x: number): number {
  if (!Number.isFinite(x)) return 0;
  return Math.max(0, Math.min(1, x));
}

interface EngagementCounts {
  like_count: number;
  repost_count: number;
  reply_count: number;
  quote_count: number;
}

/**
 * Log-compressed, normalized engagement in [0, 1]. Actions are weighted by
 * intent strength (a reply or quote signals more than a like), then log1p-
 * compressed against ENGAGEMENT_REF so a handful of viral outliers don't pin
 * every other candidate's score to ~0.
 */
export function engagementScore(c: EngagementCounts): number {
  const raw =
    (c.like_count || 0) +
    2 * (c.repost_count || 0) +
    3 * (c.reply_count || 0) +
    3 * (c.quote_count || 0);
  return clamp01(Math.log1p(raw) / Math.log1p(ENGAGEMENT_REF));
}

/**
 * Exponential half-life decay in [0, 1]: 0.5 ^ (age / halflife). A post aged
 * exactly one half-life scores 0.5, two half-lives 0.25, etc. `nowMs` is
 * passed in so a single compute pins one clock across the whole pool.
 */
export function recencyScore(
  createdAtIso: string,
  halflifeH: number,
  nowMs: number
): number {
  if (!halflifeH || halflifeH <= 0) return 0;
  const created = Date.parse(createdAtIso);
  if (!Number.isFinite(created)) return 0;
  const ageH = Math.max(0, (nowMs - created) / 3_600_000);
  return clamp01(Math.pow(0.5, ageH / halflifeH));
}

/**
 * The blended final score. `rerankScore` is the LLM's 0–100 editorial score;
 * `counts` + `createdAtIso` come from the candidate hit.
 */
export function blendedScore(opts: {
  rerankScore: number;
  counts: EngagementCounts;
  createdAtIso: string;
  weights: BlendWeights;
  nowMs: number;
}): number {
  const we = clamp01(opts.weights.engagementWeight);
  const wr = clamp01(opts.weights.recencyWeight);
  const wq = Math.max(0, 1 - we - wr);
  const q = clamp01((opts.rerankScore || 0) / 100);
  const e = engagementScore(opts.counts);
  const r = recencyScore(opts.createdAtIso, opts.weights.recencyHalflifeH, opts.nowMs);
  return wq * q + we * e + wr * r;
}
