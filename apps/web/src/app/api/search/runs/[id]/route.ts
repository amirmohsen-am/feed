/**
 * GET /api/search/runs/[id] — replay a saved run.
 *
 * Re-hydrates the vector hits from bsky.posts (so author handles, engagement,
 * etc. reflect the latest state). The reranker output is frozen from the
 * persisted JSON.
 */

import { NextRequest, NextResponse } from "next/server";
import { requireAuth, isAuthError } from "@/lib/auth";
import { getSearchRunForUser } from "@/lib/pg";
import { bskyQuery } from "@/lib/bsky-pg";

export const runtime = "nodejs";

interface PgRow {
  uri: string;
  did: string;
  text: string;
  created_at: Date;
  langs: string[];
  has_images: boolean;
  has_video: boolean;
  has_quote: boolean;
  has_external_link: boolean;
  reply_parent_uri: string | null;
  reply_root_uri: string | null;
  image_count: number;
  image_alts: string[];
  external_uri: string | null;
  external_title: string | null;
  external_desc: string | null;
  quote_uri: string | null;
  hashtags: string[];
  mention_dids: string[];
  domains: string[];
  self_labels: string[];
  like_count: number | null;
  repost_count: number | null;
  reply_count: number | null;
  quote_count: number | null;
  author_handle: string | null;
  author_display_name: string | null;
  author_avatar_cid: string | null;
}

export async function GET(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> }
) {
  const auth = await requireAuth(req);
  if (isAuthError(auth)) return auth;
  const { id } = await ctx.params;

  const run = await getSearchRunForUser(id, auth.userId);
  if (!run) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const uris = run.vector_hit_uris;
  let rows: PgRow[] = [];
  if (uris.length > 0) {
    const res = await bskyQuery<PgRow>(
      `SELECT
         p.uri, p.did, p.text, p.created_at, p.langs,
         p.has_images, p.has_video, p.has_quote, p.has_external_link,
         p.reply_parent_uri, p.reply_root_uri,
         p.image_count, p.image_alts,
         p.external_uri, p.external_title, p.external_desc, p.quote_uri,
         p.hashtags, p.mention_dids, p.domains, p.self_labels,
         pe.like_count, pe.repost_count, pe.reply_count, pe.quote_count,
         a.handle       AS author_handle,
         a.display_name AS author_display_name,
         a.avatar_cid   AS author_avatar_cid
       FROM bsky.posts p
       LEFT JOIN bsky.post_engagement pe ON pe.uri = p.uri
       LEFT JOIN bsky.authors a          ON a.did = p.did
       WHERE p.uri = ANY($1::text[])`,
      [uris]
    );
    rows = res.rows;
  }
  const byUri = new Map(rows.map((r) => [r.uri, r]));

  const hits = uris.map((uri) => {
    const r = byUri.get(uri);
    if (!r) {
      return { uri, missing: true as const };
    }
    return {
      uri,
      did: r.did,
      text: r.text,
      created_at: r.created_at.toISOString(),
      vector_score: 0,
      langs: r.langs,
      has_images: r.has_images,
      has_video: r.has_video,
      has_quote: r.has_quote,
      has_external_link: r.has_external_link,
      is_reply: r.reply_parent_uri !== null,
      reply_parent_uri: r.reply_parent_uri,
      reply_root_uri: r.reply_root_uri,
      image_count: r.image_count,
      image_alts: r.image_alts,
      external_uri: r.external_uri,
      external_title: r.external_title,
      external_desc: r.external_desc,
      quote_uri: r.quote_uri,
      hashtags: r.hashtags,
      mention_dids: r.mention_dids,
      domains: r.domains,
      self_labels: r.self_labels,
      like_count: r.like_count ?? 0,
      repost_count: r.repost_count ?? 0,
      reply_count: r.reply_count ?? 0,
      quote_count: r.quote_count ?? 0,
      author_handle: r.author_handle,
      author_display_name: r.author_display_name,
      author_avatar_cid: r.author_avatar_cid,
    };
  });

  return NextResponse.json({
    id: run.id,
    query: run.query,
    vector_k: run.vector_k,
    rerank_k: run.rerank_k,
    rerank_enabled: run.rerank_enabled,
    prompt_version_id: run.prompt_version_id,
    filters: run.filters_json,
    ms_total: run.ms_total,
    ms_rerank: run.ms_rerank,
    created_at: run.created_at,
    hits,
    kept: run.rerank_kept,
  });
}
