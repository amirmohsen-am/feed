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
 *     w_q  = 1 - w_e - w_r        (kept ≥ MIN_RELEVANCE_WEIGHT — w_e + w_r is
 *                                  capped at MAX_BIAS_WEIGHT_SUM and scaled down
 *                                  proportionally if it exceeds it, so the blend
 *                                  always nudges and never fully overrides the
 *                                  reranker's relevance term)
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

import { ENGAGEMENT_REF, MAX_BIAS_WEIGHT_SUM } from "../defaults";

interface BlendWeights {
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
function engagementScore(c: EngagementCounts): number {
  const raw =
    (c.like_count || 0) +
    2 * (c.repost_count || 0) +
    3 * (c.reply_count || 0) +
    3 * (c.quote_count || 0);
  return clamp01(Math.log1p(raw) / Math.log1p(ENGAGEMENT_REF));
}

// Clock-skew tolerance for client-supplied timestamps. A post dated up to this
// far in the future is treated as "now" (score 1); anything beyond is treated
// as untrusted and scored 0.
const RECENCY_SKEW_TOLERANCE_H = 10 / 60; // 10 minutes

/**
 * Exponential half-life decay in [0, 1]: 0.5 ^ (age / halflife). A post aged
 * exactly one half-life scores 0.5, two half-lives 0.25, etc. `nowMs` is
 * passed in so a single compute pins one clock across the whole pool.
 *
 * `createdAtIso` is the client-supplied post timestamp, which is untrusted
 * (garbage at both extremes — the indexer prunes on ingested_at for this very
 * reason). A timestamp meaningfully in the future must NOT score as maximally
 * fresh, or fake-future spam would pin itself to the top of every recency-
 * weighted feed; beyond a small clock-skew tolerance we score it 0.
 */
function recencyScore(
  createdAtIso: string,
  halflifeH: number,
  nowMs: number
): number {
  if (!halflifeH || halflifeH <= 0) return 0;
  const created = Date.parse(createdAtIso);
  if (!Number.isFinite(created)) return 0;
  const ageH = (nowMs - created) / 3_600_000;
  if (ageH < -RECENCY_SKEW_TOLERANCE_H) return 0;
  return clamp01(Math.pow(0.5, Math.max(0, ageH) / halflifeH));
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
  let we = clamp01(opts.weights.engagementWeight);
  let wr = clamp01(opts.weights.recencyWeight);
  // Defensive floor for legacy/out-of-band rows: scale the bias weights down
  // proportionally if they'd sink relevance below its floor. The write path
  // (api/feeds) already caps the stored values, so this is a no-op for any feed
  // edited through the UI.
  const biasSum = we + wr;
  if (biasSum > MAX_BIAS_WEIGHT_SUM) {
    const scale = MAX_BIAS_WEIGHT_SUM / biasSum;
    we *= scale;
    wr *= scale;
  }
  const wq = 1 - we - wr;
  const q = clamp01((opts.rerankScore || 0) / 100);
  const e = engagementScore(opts.counts);
  const r = recencyScore(opts.createdAtIso, opts.weights.recencyHalflifeH, opts.nowMs);
  return wq * q + we * e + wr * r;
}
