import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import { getSecret } from "@/lib/secrets";
import { jsonError } from "@/lib/api";
import type { GEFeedRequest, GEFeedResponse } from "@/app/greenearth/types";
import type { Post } from "@/app/curator/feedTypes";

// Throwaway prototype: proxy the Green Earth recommendation pipeline
// (candidates -> rank -> diversify) for a given Bluesky handle, then hydrate
// the ranked AT-URIs into full posts via the public Bluesky AppView. The API
// key stays server-side (never sent to the browser).
export const runtime = "nodejs";

const GE_BASE = process.env.GREEN_EARTH_API_BASE || "https://api.greenearth.social";
const APPVIEW = "https://public.api.bsky.app";
const GET_POSTS_BATCH = 25;

// ---------------------------------------------------------------------------
// Green Earth API shapes (only the fields we use)
// ---------------------------------------------------------------------------

interface Candidate {
  at_uri: string;
  content?: string | null;
  score?: number | null;
  generator_name?: string | null;
  minilm_l12_embedding?: string | null;
  author_did?: string | null;
}

interface Ranking {
  at_uri: string;
  rank: number;
  rank_score?: number | null;
}

async function gePost<T>(path: string, apiKey: string, body: unknown): Promise<T> {
  const res = await fetch(`${GE_BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-API-Key": apiKey },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Green Earth ${path} ${res.status}: ${text.slice(0, 300)}`);
  }
  return res.json() as Promise<T>;
}

async function resolveDid(handleOrDid: string): Promise<string> {
  const h = handleOrDid.trim().replace(/^@/, "");
  if (h.startsWith("did:")) return h;
  const res = await fetch(
    `${APPVIEW}/xrpc/com.atproto.identity.resolveHandle?handle=${encodeURIComponent(h)}`
  );
  if (!res.ok) throw new Error(`Could not resolve handle "${h}" (${res.status})`);
  const json = (await res.json()) as { did?: string };
  if (!json.did) throw new Error(`Handle "${h}" did not resolve to a DID`);
  return json.did;
}

// ---------------------------------------------------------------------------
// AppView getPosts hydration
// ---------------------------------------------------------------------------

interface AppViewImage {
  thumb?: string;
  fullsize?: string;
  alt?: string;
}

interface AppViewAuthor {
  did: string;
  handle?: string;
  displayName?: string;
  avatar?: string;
}

// A record#view (quote target). Self-referential `record` covers the
// recordWithMedia#view nesting (embed.record.record).
interface AppViewRecordView {
  uri?: string;
  author?: AppViewAuthor;
  value?: { text?: string };
  record?: AppViewRecordView;
}

interface AppViewEmbed {
  $type?: string;
  images?: AppViewImage[];
  playlist?: string;
  thumbnail?: string;
  external?: { uri?: string; title?: string; description?: string; thumb?: string };
  record?: AppViewRecordView;
  media?: AppViewEmbed;
}

interface AppViewPost {
  uri: string;
  author: AppViewAuthor;
  record?: {
    text?: string;
    createdAt?: string;
    reply?: { parent?: { uri?: string } };
  };
  embed?: AppViewEmbed;
  replyCount?: number;
  repostCount?: number;
  likeCount?: number;
  quoteCount?: number;
  indexedAt?: string;
}

// recordWithMedia nests the media one level deeper; everything else has media
// fields directly on the embed.
function mediaEmbed(e?: AppViewEmbed): AppViewEmbed | undefined {
  if (!e) return undefined;
  if (e.$type === "app.bsky.embed.recordWithMedia#view") return e.media;
  return e;
}

function extractImages(e?: AppViewEmbed): { urls: string[]; alts: string[] } {
  const m = mediaEmbed(e);
  const urls: string[] = [];
  const alts: string[] = [];
  for (const img of m?.images ?? []) {
    const url = img.thumb ?? img.fullsize ?? "";
    if (url) {
      urls.push(url);
      alts.push(img.alt ?? "");
    }
  }
  return { urls, alts };
}

function extractVideo(e?: AppViewEmbed): { playlist: string | null; thumbnail: string | null } {
  const m = mediaEmbed(e);
  if (m?.$type === "app.bsky.embed.video#view") {
    return { playlist: m.playlist ?? null, thumbnail: m.thumbnail ?? null };
  }
  return { playlist: null, thumbnail: null };
}

// The quoted post's own URI — PostCard hydrates the quote block itself, keyed
// by quote_uri, so we only need to surface the URI here.
function extractQuoteUri(e?: AppViewEmbed): string | null {
  if (!e) return null;
  if (e.$type === "app.bsky.embed.record#view") return e.record?.uri ?? null;
  if (e.$type === "app.bsky.embed.recordWithMedia#view") return e.record?.record?.uri ?? null;
  return null;
}

// Bluesky avatar URLs look like
//   https://cdn.bsky.app/img/avatar/plain/<did>/<cid>       (no extension)
// PostCard rebuilds the URL from (did, cid) via avatarUrl(), so pull the cid
// out — the last path segment, minus any "@jpeg"-style suffix.
function avatarCid(avatar?: string): string | null {
  if (!avatar) return null;
  const seg = avatar.split("/").pop() ?? "";
  const cid = seg.split("@")[0];
  return cid || null;
}

async function hydrate(uris: string[]): Promise<Post[]> {
  const batches: string[][] = [];
  for (let i = 0; i < uris.length; i += GET_POSTS_BATCH) {
    batches.push(uris.slice(i, i + GET_POSTS_BATCH));
  }

  const results = await Promise.all(
    batches.map(async (batch) => {
      const params = new URLSearchParams();
      for (const uri of batch) params.append("uris", uri);
      const res = await fetch(`${APPVIEW}/xrpc/app.bsky.feed.getPosts?${params}`);
      if (!res.ok) return [] as AppViewPost[];
      const json = (await res.json()) as { posts?: AppViewPost[] };
      return json.posts ?? [];
    })
  );

  const out: Post[] = [];
  for (const posts of results) {
    for (const p of posts) {
      const video = extractVideo(p.embed);
      const { urls: imageUrls, alts: imageAlts } = extractImages(p.embed);
      const externalM = mediaEmbed(p.embed);
      const external =
        externalM?.$type === "app.bsky.embed.external#view" ? externalM.external : undefined;
      out.push({
        uri: p.uri,
        author_did: p.author.did,
        text: p.record?.text ?? "",
        score: 0,
        indexed_at: p.indexedAt ?? p.record?.createdAt ?? "",
        author_handle: p.author.handle ?? null,
        author_display_name: p.author.displayName ?? null,
        author_avatar_cid: avatarCid(p.author.avatar),
        like_count: p.likeCount ?? 0,
        repost_count: p.repostCount ?? 0,
        reply_count: p.replyCount ?? 0,
        quote_count: p.quoteCount ?? 0,
        external_uri: external?.uri ?? null,
        external_title: external?.title ?? null,
        external_desc: external?.description ?? null,
        external_thumb: external?.thumb ?? null,
        quote_uri: extractQuoteUri(p.embed),
        has_images: imageUrls.length > 0,
        has_video: !!video.playlist,
        image_count: imageUrls.length,
        image_alts: imageAlts,
        image_urls: imageUrls,
        video_thumbnail: video.thumbnail,
        video_playlist: video.playlist,
        is_reply: !!p.record?.reply,
        reply_parent_uri: p.record?.reply?.parent?.uri ?? null,
      });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Route
// ---------------------------------------------------------------------------

export async function POST(req: NextRequest) {
  await requireAuth(); // ensures a session exists; user_did comes from the handle
  try {
    const body = (await req.json()) as GEFeedRequest;

    if (!body.handle?.trim()) {
      return NextResponse.json({ error: "handle is required" }, { status: 400 });
    }
    const generators = (body.generators ?? []).filter((g) => g.name && g.weight > 0);
    if (generators.length === 0) {
      return NextResponse.json({ error: "select at least one generator" }, { status: 400 });
    }

    const apiKey = await getSecret("green-earth-api-key");
    const userDid = await resolveDid(body.handle);
    const numCandidates = Math.min(Math.max(body.numCandidates || 50, 1), 200);

    const stages: string[] = [];

    // 1) candidates
    const gen = await gePost<{ candidates: Candidate[] }>("/candidates/generate", apiKey, {
      generators,
      user_did: userDid,
      num_candidates: numCandidates,
      video_only: !!body.videoOnly,
      exclude_uris: [],
    });
    let candidates = gen.candidates ?? [];
    stages.push(`candidates → ${candidates.length}`);

    // 2) rank (optional) — reorder the full candidate objects by the returned order
    const rankScores = new Map<string, number>();
    if (body.ranker && body.ranker !== "none" && candidates.length > 0) {
      const ranked = await gePost<{ rankings: Ranking[] }>("/rank/predict", apiKey, {
        candidates,
        models: [{ name: body.ranker, weight: 1 }],
        user_did: userDid,
      });
      const byUri = new Map(candidates.map((c) => [c.at_uri, c]));
      candidates = ranked.rankings
        .map((r) => {
          if (typeof r.rank_score === "number") rankScores.set(r.at_uri, r.rank_score);
          return byUri.get(r.at_uri);
        })
        .filter((c): c is Candidate => Boolean(c));
      stages.push(`rank (${body.ranker}) → ${candidates.length}`);
    }

    // 3) diversify (optional)
    if (body.diversify && candidates.length > 0) {
      const div = await gePost<{ candidates: Candidate[] }>("/diversify", apiKey, {
        candidates,
      });
      candidates = div.candidates ?? candidates;
      stages.push(`diversify → ${candidates.length}`);
    }

    // 4) hydrate ranked URIs into renderable posts
    const uris = candidates.map((c) => c.at_uri).filter(Boolean);
    const posts = await hydrate(uris);

    // attach GE recommendation metadata + restore pipeline order (getPosts can
    // drop/reorder relative to the request). Folded into the curator Post shape:
    // candidate score → score, ranker score → rerank_score, generator name →
    // rerank_reason (all shown in PostCard's debug row).
    const candByUri = new Map(candidates.map((c) => [c.at_uri, c]));
    for (const p of posts) {
      const c = candByUri.get(p.uri);
      p.score = c?.score ?? 0;
      const rs = rankScores.get(p.uri);
      if (typeof rs === "number") p.rerank_score = rs;
      if (c?.generator_name) p.rerank_reason = c.generator_name;
    }
    const order = new Map(uris.map((u, i) => [u, i]));
    posts.sort((a, b) => (order.get(a.uri) ?? 0) - (order.get(b.uri) ?? 0));
    stages.push(`hydrated → ${posts.length}`);

    const payload: GEFeedResponse = { did: userDid, stages, posts };
    return NextResponse.json(payload);
  } catch (e) {
    return jsonError(e, "green-earth");
  }
}
