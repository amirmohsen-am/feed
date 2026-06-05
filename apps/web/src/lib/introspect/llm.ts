/**
 * Extractor + Aggregator LLM calls (design §4.4).
 *
 * Both prompts deliberately follow the LFM Figure 7 shape: setup → data →
 * one-line instruction → length/style constraint. No JSON output schemas
 * — both return free prose. The Extractor runs once per batch (its prose
 * is saved permanently); the Aggregator re-runs over all extractor outputs
 * so far after every "Process next batch" click.
 */

import Anthropic from "@anthropic-ai/sdk";
import { ensureEnvFromSecret } from "@/lib/secrets";
import { fetchImages, imageKey, type CachedImage } from "./images";
import type {
  BatchNote,
  CallTelemetry,
  Engagement,
  FeedSeedPrompts,
  Profile,
  Subject,
} from "./types";

const MODEL_ID = "claude-sonnet-4-6";
const MAX_OUTPUT_EXTRACTOR = 1200; // ~200-word paragraph + slack
const MAX_OUTPUT_AGGREGATOR = 4096; // "no length limit — write what data warrants"
const MAX_OUTPUT_FEED_SEEDS = 500; // 5 prompts × ~3 short sentences each, with slack
// Hard limit only — Claude's messages API rejects more than 100 images in a
// single request. We attach every image we can fit within this ceiling.
const IMAGES_PER_BATCH_CAP = 100;

/**
 * Sonnet 4.6 standard-tier prices (per million tokens). Used to compute the
 * cost the UI surfaces on each call card. Updated alongside model upgrades.
 *
 * Cache prices are kept here because computeCost reads cache_* fields off
 * the usage block — but no cache_control markers are set on any messages,
 * so cache_read / cache_write are always 0 in practice. Caching is a small
 * win at this scale (the static preamble is only ~500 tokens vs ~65K of
 * varying content per call); wire it when the demo scales up.
 */
const PRICE_INPUT_PER_M = 3.0;
const PRICE_OUTPUT_PER_M = 15.0;
const PRICE_CACHE_READ_PER_M = 0.3;
const PRICE_CACHE_WRITE_PER_M = 3.75;

let _client: Anthropic | null = null;
async function client(): Promise<Anthropic> {
  if (_client) return _client;
  await ensureEnvFromSecret("anthropic-api-key");
  _client = new Anthropic();
  return _client;
}

// ── Prompts (design §4.4.a / §4.4.b, verbatim) ───────────────────────────

const EXTRACTOR_INSTRUCTIONS = `Based on this batch of engagements, write a summary of what this batch reveals about the user's interests, voice, and preferences. Be specific — name concrete topics, not abstract categories. Note what recurs across multiple engagements and what stands out as different from the rest of this batch.

Begin your response with a single line in the exact form \`HEADLINE: <title>\`, where <title> is a specific ≤10-word phrase capturing this batch's dominant theme (no trailing period). Then a blank line, then a single paragraph of ~200 words. Do not quote third-party post text. Verbatim quoting of the user's own words (from their quotes and replies) is allowed when characteristic.`;

const EXTRACTOR_PREAMBLE = `The following are recent Bluesky engagements by a single user — likes, reposts, quotes, original posts, and replies, in chronological order. The user wrote no text in their likes or reposts; what they wrote (on quotes, posts, replies) is included alongside the third-party content. Images, external link cards, and the post being quoted or replied to are attached where applicable.`;

const AGGREGATOR_PREAMBLE = `The following are summaries of batches of Bluesky engagements from a single user, presented in chronological order (oldest batch first). Each summary was generated from a single batch of ~100 engagements. Note: batches were PROCESSED newest-first (so each Extractor saw later batches before this chronological presentation), but you're getting them ordered oldest → newest so you can synthesize evolution naturally.`;

const AGGREGATOR_INSTRUCTIONS = `Synthesize these batch summaries into a single coherent profile of the user. Cover both what is consistent across batches and what is shifting. Be specific about topics, voices, and patterns. Where short-term and long-term behavior diverge, name the divergence explicitly. State briefly which signal types (likes / reposts / quotes / posts / replies) you're weighting most heavily for this user and why.

Every claim must be grounded in specific engagements present in the batch summaries or the anchor records. Do not infer character traits, values, motivations, or behaviors the data does not directly support — if something isn't shown, omit it rather than filling the gap with plausible-sounding inference. Do not write meta-commentary about your own confidence, the size of the input, or what you cannot assess.

Do not quote third-party post text.`;

// ── Engagement → text serialization ──────────────────────────────────────

/**
 * Serialize one engagement record to the text format shown in design §5.1.
 * Image bytes go in separately as vision content blocks; this string just
 * announces which images are attached (so the model can correlate them).
 */
function renderEngagement(
  e: Engagement,
  imageOrdinal: { next: number },
  imagesAttached: Set<string>
): string {
  const lines: string[] = [];
  const typeLabel = e.type.toUpperCase();
  lines.push(`[E#${e.id}]  ${typeLabel}  ${e.ts}`);

  if (e.userText) {
    lines.push(`  user text: ${oneLine(e.userText)}`);
  }

  lines.push(...renderSubject(e.subject, "  ", imageOrdinal, imagesAttached));
  return lines.join("\n");
}

function renderSubject(
  s: Subject,
  indent: string,
  imageOrdinal: { next: number },
  imagesAttached: Set<string>
): string[] {
  const lines: string[] = [];
  if (s.unavailable) {
    lines.push(`${indent}subject: ${s.author}  (unavailable)`);
    return lines;
  }
  lines.push(`${indent}subject:   ${s.author}`);
  if (s.text) lines.push(`${indent}text:      ${oneLine(s.text)}`);

  if (s.imageCids && s.imageCids.length > 0 && s.authorDid) {
    const tags: string[] = [];
    for (const cid of s.imageCids) {
      const key = imageKey(s.authorDid, cid);
      if (imagesAttached.has(key)) {
        tags.push(`<image ${imageOrdinal.next++}>`);
      }
    }
    if (tags.length > 0) {
      lines.push(`${indent}images:    ${tags.join(", ")}`);
    } else {
      lines.push(`${indent}images:    (${s.imageCids.length} attached, not fetched)`);
    }
  }

  if (s.linkCard) {
    lines.push(
      `${indent}link card: { title: "${oneLine(s.linkCard.title)}", description: "${oneLine(
        s.linkCard.description
      )}" }`
    );
  }

  if (s.quoting) {
    lines.push(`${indent}quoting:`);
    lines.push(
      ...renderSubject(s.quoting, indent + "  ", imageOrdinal, imagesAttached)
    );
  }
  if (s.replyingTo) {
    lines.push(`${indent}replying to:`);
    lines.push(
      ...renderSubject(s.replyingTo, indent + "  ", imageOrdinal, imagesAttached)
    );
  }
  return lines;
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/**
 * Walk the engagement graph and collect every (authorDid, cid) image pair we
 * can serve to Claude. Includes:
 *   - all images on the engaged-with subject
 *   - all images on the quoted record (one level)
 *   - all images on the replied-to record (one level)
 * Deduped by (authorDid, cid). Engagements are newest-first as passed in, so
 * the trim at IMAGES_PER_BATCH_CAP keeps the most recent N — matters only
 * when a batch has more images than Claude's per-request limit.
 */
function collectImageRefs(engagements: Engagement[]): Array<{
  engagementId: number;
  authorDid: string;
  cid: string;
}> {
  const refs: Array<{
    engagementId: number;
    authorDid: string;
    cid: string;
  }> = [];
  const seen = new Set<string>();
  const push = (eId: number, did: string | undefined, cid: string) => {
    if (!did) return;
    const k = `${did}/${cid}`;
    if (seen.has(k)) return;
    seen.add(k);
    refs.push({ engagementId: eId, authorDid: did, cid });
  };
  const visit = (eId: number, s: Subject | null | undefined) => {
    if (!s) return;
    if (s.imageCids) for (const cid of s.imageCids) push(eId, s.authorDid, cid);
    visit(eId, s.quoting);
    visit(eId, s.replyingTo);
  };
  for (const e of engagements) visit(e.id, e.subject);
  return refs.slice(0, IMAGES_PER_BATCH_CAP);
}

// ── Pricing ──────────────────────────────────────────────────────────────

function computeCost(usage: {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
}): number {
  const input = usage.input_tokens;
  const output = usage.output_tokens;
  const cacheRead = usage.cache_read_input_tokens ?? 0;
  const cacheWrite = usage.cache_creation_input_tokens ?? 0;
  return (
    (input * PRICE_INPUT_PER_M) / 1_000_000 +
    (output * PRICE_OUTPUT_PER_M) / 1_000_000 +
    (cacheRead * PRICE_CACHE_READ_PER_M) / 1_000_000 +
    (cacheWrite * PRICE_CACHE_WRITE_PER_M) / 1_000_000
  );
}

// ── Streaming helper ───────────────────────────────────────────────────────

/** Callback fired with each incremental text delta as the model writes. */
export type OnDelta = (textDelta: string) => void;

type StreamArgs = Anthropic.Messages.MessageCreateParamsNonStreaming;

/**
 * Run one streaming Claude call. Forwards each text delta to `onDelta` (when
 * provided) and returns the assembled text + usage + latency once the stream
 * finishes. Used by the Extractor and Aggregator so the route can surface
 * live progress; pass no `onDelta` to behave like a buffered call.
 */
async function streamCall(
  args: StreamArgs,
  onDelta?: OnDelta
): Promise<{ text: string; telemetry: CallTelemetry }> {
  const t0 = Date.now();
  const stream = (await client()).messages.stream(args);
  if (onDelta) stream.on("text", (delta) => onDelta(delta));
  const resp = await stream.finalMessage();
  const latencyMs = Date.now() - t0;

  const text =
    resp.content[0]?.type === "text" ? resp.content[0].text.trim() : "";

  const telemetry: CallTelemetry = {
    modelId: MODEL_ID,
    inputTokens: resp.usage.input_tokens,
    outputTokens: resp.usage.output_tokens,
    cacheReadTokens: resp.usage.cache_read_input_tokens ?? undefined,
    cacheCreationTokens: resp.usage.cache_creation_input_tokens ?? undefined,
    costUsd: computeCost(resp.usage),
    latencyMs,
    processedAt: new Date().toISOString(),
  };
  return { text, telemetry };
}

/**
 * Split the Extractor's `HEADLINE: …` first line off the prose body. Tolerant
 * of a missing headline (older notes, or a model that ignored the instruction)
 * — returns an empty headline and the text unchanged in that case.
 */
function splitHeadline(raw: string): { headline: string; body: string } {
  const m = raw.match(/^\s*HEADLINE:\s*(.+?)\s*(?:\n|$)/i);
  if (!m) return { headline: "", body: raw.trim() };
  const headline = m[1].replace(/\.$/, "").trim();
  const body = raw.slice(m[0].length).trim();
  return { headline, body };
}

// ── Extractor ────────────────────────────────────────────────────────────

export interface ExtractorResult {
  note: BatchNote;
}

export async function runExtractor(
  batchIndex: number,
  batchHash: string,
  engagements: Engagement[],
  onDelta?: OnDelta
): Promise<ExtractorResult> {
  // ── Fetch images for vision attachment ─────────────────────────────
  const refs = collectImageRefs(engagements);
  const imageMap = refs.length > 0 ? await fetchImages(refs) : new Map();
  const attached: Set<string> = new Set(imageMap.keys());

  // ── Render engagement text (newest-first as composed) ─────────────
  const imgOrd = { next: 1 };
  const recordLines = engagements
    .map((e) => renderEngagement(e, imgOrd, attached))
    .join("\n\n");

  // ── Build content blocks: preamble + images + records + instructions
  type Block =
    | { type: "text"; text: string }
    | {
        type: "image";
        source: { type: "base64"; media_type: "image/jpeg"; data: string };
      };
  const blocks: Block[] = [];
  blocks.push({ type: "text", text: EXTRACTOR_PREAMBLE });

  // Attach images in declared order (matches the <image N> tags above)
  let n = 0;
  for (const ref of refs) {
    const img = imageMap.get(imageKey(ref.authorDid, ref.cid));
    if (!img) continue;
    n++;
    blocks.push({
      type: "image",
      source: {
        type: "base64",
        media_type: "image/jpeg",
        data: (img as CachedImage).bytes.toString("base64"),
      },
    });
  }

  blocks.push({
    type: "text",
    text: `Engagement records (batch ${batchIndex}, newest-first):\n\n${recordLines}`,
  });
  blocks.push({ type: "text", text: EXTRACTOR_INSTRUCTIONS });

  // ── Call Claude (streaming) ───────────────────────────────────────
  const { text: raw, telemetry } = await streamCall(
    {
      model: MODEL_ID,
      max_tokens: MAX_OUTPUT_EXTRACTOR,
      messages: [{ role: "user", content: blocks }],
    },
    onDelta
  );

  const { headline, body } = splitHeadline(raw);

  return {
    note: {
      batchIndex,
      hash: batchHash,
      headline,
      text: body,
      telemetry,
      imagesAttached: n,
      imagesFailed: refs.length - n,
    },
  };
}

// ── Aggregator ───────────────────────────────────────────────────────────

export async function runAggregator(
  batchNotes: BatchNote[],
  anchorEngagements: Engagement[],
  onDelta?: OnDelta
): Promise<Profile> {
  // Aggregator sees batches oldest → newest so synthesis reads as an
  // evolution (design §3 Option D step 3).
  const ordered = batchNotes
    .slice()
    .sort((a, b) => b.batchIndex - a.batchIndex); // batch index N = oldest (batch 1 = newest)
  const noteBlock = ordered
    .map(
      (b, i) =>
        `[summary ${i + 1}/${ordered.length}, from batch ${b.batchIndex}]\n${b.text.trim()}`
    )
    .join("\n\n");

  // Anchor records — random sample across all engagements that were already
  // processed. No images here (text-only); the prose batch notes carry the
  // visual semantics already. Keeps Aggregator dirt-cheap.
  const imgOrd = { next: 1 };
  const anchorBlock = anchorEngagements
    .map((e) => renderEngagement(e, imgOrd, new Set()))
    .join("\n\n");

  const userText =
    `${AGGREGATOR_PREAMBLE}\n\n${noteBlock}\n\n` +
    `For grounding, here are ${anchorEngagements.length} randomly-selected raw engagement records drawn across the batches:\n\n${anchorBlock}\n\n` +
    AGGREGATOR_INSTRUCTIONS;

  const { text, telemetry } = await streamCall(
    {
      model: MODEL_ID,
      max_tokens: MAX_OUTPUT_AGGREGATOR,
      messages: [{ role: "user", content: userText }],
    },
    onDelta
  );

  return {
    text,
    telemetry,
    fromBatchIndices: batchNotes.map((b) => b.batchIndex).sort((a, b) => a - b),
  };
}

// ── Feed seed prompt generator ───────────────────────────────────────────

const FEED_SEEDS_SYSTEM = `You generate feed-seed prompts for a Bluesky feed curator agent. Given a profile of a user (synthesized from their engagement history), emit between 1 and 5 short natural-language prompts that the user could hand to the curator as the opening message of a new feed.

The curator agent expects free-form English — conversational, 1 to 3 sentences per prompt, opening with phrases like "Show me…", "I want…", or "Posts about…". The curator does its own follow-up questions; your prompts are starting points, not finished specs.

Each prompt should be ACTIONABLE and SPECIFIC:
- Name concrete topics, projects, jargon, or community names — not abstract categories. Prefer "transformer architecture, RLHF, open-source LLMs" over "AI". Prefer "carbon capture and direct air capture startups" over "climate".
- One angle per prompt. Don't pack multiple unrelated interests into a single prompt — that's what having multiple prompts is for.
- It's fine to invoke social shape ("from people I follow", "from researchers, not just hot takes") or tone ("thoughtful long-form, not dunks") when the profile supports it.

Diversity rule: the prompts you emit must cover DIFFERENT facets of the profile. Don't emit five variants of the same theme. Mix core interests, niche interests, distinct voices/communities the user engages with, and timely angles where they appear in the profile.

Count rule: emit FEWER prompts when the profile genuinely supports fewer distinct directions. If the profile clearly carries only 2 strong threads, emit 2. The cap is 5, not the target.

Anti-patterns (do not do these):
- No numbered lists. No "1. …", no leading bullets/dashes.
- No quoted strings around the prompts.
- No questions to the user. The output is read by the user as a button label and sent to a downstream agent — not used to interrogate them.
- No abstract category labels alone ("Technology", "Politics"). Lead with the specific angle.
- No meta-commentary about the profile or how you chose the prompts.

Output format: exactly one prompt per line. Plain text. No markdown, no numbering, no quotes. A trailing newline is fine. Nothing else in the response.`;

/**
 * One Anthropic call. Input: the Aggregator profile text. Output: 1–5 parsed
 * seed prompts (plus telemetry). On parse failure, returns an empty list —
 * the caller treats that the same as "skip the suggestions block this turn."
 */
export async function runFeedSeedGenerator(
  profile: Profile
): Promise<FeedSeedPrompts> {
  const t0 = Date.now();
  const resp = await (await client()).messages.create({
    model: MODEL_ID,
    max_tokens: MAX_OUTPUT_FEED_SEEDS,
    system: FEED_SEEDS_SYSTEM,
    messages: [
      {
        role: "user",
        content: `User profile:\n\n${profile.text.trim()}\n\nEmit the seed prompts now.`,
      },
    ],
  });
  const latencyMs = Date.now() - t0;

  const raw =
    resp.content[0]?.type === "text" ? resp.content[0].text : "";
  const prompts = parseSeedPrompts(raw);

  const telemetry: CallTelemetry = {
    modelId: MODEL_ID,
    inputTokens: resp.usage.input_tokens,
    outputTokens: resp.usage.output_tokens,
    cacheReadTokens: resp.usage.cache_read_input_tokens ?? undefined,
    cacheCreationTokens: resp.usage.cache_creation_input_tokens ?? undefined,
    costUsd: computeCost(resp.usage),
    latencyMs,
    processedAt: new Date().toISOString(),
  };

  return {
    prompts,
    telemetry,
    generatedAt: new Date().toISOString(),
  };
}

/**
 * Parse the model's plain-text output into a clean list. One prompt per
 * line; we strip leading bullets/numbers defensively, drop blanks, strip
 * surrounding quotes, dedupe, and cap at 5.
 */
function parseSeedPrompts(raw: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const line of raw.split(/\r?\n/)) {
    let s = line.trim();
    if (!s) continue;
    // Defensive: model occasionally ignores the no-numbering rule.
    s = s.replace(/^(?:[-*•]|\d+[.)])\s+/, "");
    // Strip wrapping quotes if present on both sides.
    if (
      (s.startsWith('"') && s.endsWith('"')) ||
      (s.startsWith("'") && s.endsWith("'"))
    ) {
      s = s.slice(1, -1).trim();
    }
    if (!s) continue;
    const key = s.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(s);
    if (out.length >= 5) break;
  }
  return out;
}

/** Random sample ~10 engagements across all processed batches. */
export function pickAnchorEngagements(
  engagements: Engagement[],
  processedBatchIds: Set<number>,
  batchIdByEngagementId: Map<number, number>,
  count = 10
): Engagement[] {
  const eligible = engagements.filter((e) => {
    const b = batchIdByEngagementId.get(e.id);
    return b !== undefined && processedBatchIds.has(b);
  });
  if (eligible.length <= count) return eligible.slice();
  const out: Engagement[] = [];
  const pool = eligible.slice();
  for (let i = 0; i < count; i++) {
    const j = Math.floor(Math.random() * pool.length);
    out.push(pool[j]);
    pool.splice(j, 1);
  }
  return out;
}
