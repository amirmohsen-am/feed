/**
 * Claude reranker.
 *
 * Given a query and N candidate posts (from Vertex vector search), prompt
 * Sonnet 4.6 with a user-saved editorial system prompt and ask it to return
 * a sorted JSON array of up to K kept items: `[{i, score, reason}]`.
 *
 * `i` is the candidate index we sent in, so the client/server can join back
 * to the original hit without round-tripping URIs through the LLM.
 *
 * The output contract (the format suffix on the system prompt) lives here,
 * not in user-saved prompt text — so we can fix parsing without rewriting
 * every saved prompt.
 */

import Anthropic from "@anthropic-ai/sdk";
import { ensureEnvFromSecret } from "./secrets";
import type { VectorHit } from "./vector-search";

export const RERANK_MODEL = "claude-sonnet-4-6";

const RERANK_OUTPUT_CONTRACT = `

Return JSON only — a single array of up to N items, sorted best-first.
Each item: {"i": <int candidate index>, "score": <int 0-100>, "reason": "<one short sentence>"}.
Do NOT include items you would not surface. Do NOT include any prose outside the array.`;

let _client: Anthropic | null = null;
async function client(): Promise<Anthropic> {
  if (_client) return _client;
  await ensureEnvFromSecret("anthropic-api-key");
  _client = new Anthropic();
  return _client;
}

export interface RerankedItem {
  i: number;
  score: number;
  reason: string;
}

export interface RerankResult {
  kept: RerankedItem[];
  ms_rerank: number;
}

function trimCandidate(h: VectorHit, i: number) {
  return {
    i,
    text: h.text,
    author: h.author_handle ? `@${h.author_handle}` : null,
    likes: h.like_count,
    reposts: h.repost_count,
    image_alt: h.image_alts.length > 0 ? h.image_alts.join(" / ") : undefined,
    ext_title: h.external_title || undefined,
  };
}

function safeParseArray(raw: string): unknown {
  // Strip code fences if the model wrapped output despite the contract.
  const stripped = raw
    .replace(/^\s*```(?:json)?\s*/i, "")
    .replace(/\s*```\s*$/i, "")
    .trim();
  // Find the first '[' and the matching last ']'.
  const start = stripped.indexOf("[");
  const end = stripped.lastIndexOf("]");
  if (start === -1 || end === -1 || end <= start) {
    throw new Error("reranker returned no JSON array");
  }
  return JSON.parse(stripped.slice(start, end + 1));
}

export async function rerank(opts: {
  query: string;
  candidates: VectorHit[];
  topK: number;
  systemPrompt: string;
}): Promise<RerankResult> {
  const { query, candidates, topK, systemPrompt } = opts;
  const t0 = performance.now();

  const trimmed = candidates.map((h, i) => trimCandidate(h, i));
  const userMessage =
    `Query: ${JSON.stringify(query)}\n` +
    `N = ${topK}\n` +
    `Candidates (n=${candidates.length}):\n` +
    JSON.stringify(trimmed);

  const system = systemPrompt + RERANK_OUTPUT_CONTRACT;

  const res = await (await client()).messages.create({
    model: RERANK_MODEL,
    max_tokens: 4096,
    system,
    messages: [{ role: "user", content: userMessage }],
  });

  const text =
    res.content[0]?.type === "text" ? res.content[0].text : "";
  const parsed = safeParseArray(text);
  if (!Array.isArray(parsed)) {
    throw new Error("reranker output was not a JSON array");
  }

  const kept: RerankedItem[] = [];
  const seen = new Set<number>();
  for (const raw of parsed) {
    if (!raw || typeof raw !== "object") continue;
    const r = raw as { i?: unknown; score?: unknown; reason?: unknown };
    const i = typeof r.i === "number" ? r.i : Number(r.i);
    const score = typeof r.score === "number" ? r.score : Number(r.score);
    const reason = typeof r.reason === "string" ? r.reason : "";
    if (!Number.isInteger(i) || i < 0 || i >= candidates.length) continue;
    if (seen.has(i)) continue;
    seen.add(i);
    kept.push({
      i,
      score: Number.isFinite(score) ? Math.max(0, Math.min(100, score)) : 0,
      reason,
    });
    if (kept.length >= topK) break;
  }

  return { kept, ms_rerank: Math.round(performance.now() - t0) };
}
