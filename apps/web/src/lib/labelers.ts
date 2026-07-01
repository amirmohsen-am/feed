// Labeler directory data access.
//
// The set of known labeler DIDs lives in `bsky.labelers` on bsky-db (seeded once
// from a public directory, then maintained by the Jetstream labeler consumer).
// Here we read that set and enrich it on demand from the AppView, whose
// `app.bsky.labeler.getServices?detailed=true` returns the authoritative
// on-protocol `likeCount` plus the labeler's profile. We never aggregate likes
// ourselves.
//
// Refresh strategy: enrichment is cached in the same row with `enriched_at`.
// On read, if nothing is enriched yet (fresh seed) we refresh synchronously;
// if the cache is merely stale we serve it and refresh in the background.

import { bskyQuery } from "./bsky-pg";

const APPVIEW_HOST =
  process.env.BLUESKY_APPVIEW_HOST ?? "https://public.api.bsky.app";

// app.bsky.labeler.getServices caps the dids array per call; 25 matches the
// other AppView batch sizes used in this codebase.
const GET_SERVICES_BATCH = 25;

// How long an enriched row stays fresh before a background refresh is kicked.
const TTL_MS = 60 * 60 * 1000; // 1 hour

export interface Labeler {
  did: string;
  handle: string | null;
  displayName: string | null;
  description: string | null;
  avatarUrl: string | null;
  likeCount: number | null;
}

interface LabelerRow {
  did: string;
  handle: string | null;
  display_name: string | null;
  description: string | null;
  avatar_url: string | null;
  like_count: number | null;
}

function rowToLabeler(r: LabelerRow): Labeler {
  return {
    did: r.did,
    handle: r.handle,
    displayName: r.display_name,
    description: r.description,
    avatarUrl: r.avatar_url,
    likeCount: r.like_count,
  };
}

/** Enriched labelers, most-liked first. */
async function readEnriched(): Promise<Labeler[]> {
  const { rows } = await bskyQuery<LabelerRow>(
    `SELECT did, handle, display_name, description, avatar_url, like_count
       FROM bsky.labelers
      WHERE enriched_at IS NOT NULL AND like_count IS NOT NULL
      ORDER BY like_count DESC NULLS LAST, handle ASC`
  );
  return rows.map(rowToLabeler);
}

/**
 * True when the freshest enrichment is past TTL (or nothing is enriched yet).
 *
 * TTL-based only: every refresh re-attempts all DIDs, including newly discovered
 * ones and DIDs whose service was taken down (those just return no view and stay
 * unenriched). Counting unenriched rows here would refresh on every request,
 * since taken-down DIDs never enrich.
 */
async function isStale(): Promise<boolean> {
  const { rows } = await bskyQuery<{ newest: Date | null }>(
    `SELECT max(enriched_at) AS newest FROM bsky.labelers`
  );
  const { newest } = rows[0];
  if (!newest) return true;
  return Date.now() - new Date(newest).getTime() > TTL_MS;
}

interface LabelerView {
  creator?: {
    did?: string;
    handle?: string;
    displayName?: string;
    description?: string;
    avatar?: string;
  };
  likeCount?: number;
}

async function fetchServices(dids: string[]): Promise<LabelerView[]> {
  const params = new URLSearchParams();
  for (const did of dids) params.append("dids", did);
  params.append("detailed", "true");
  const url = `${APPVIEW_HOST}/xrpc/app.bsky.labeler.getServices?${params}`;
  const res = await fetch(url);
  if (!res.ok) {
    console.warn(
      `[labelers] AppView getServices ${res.status} (batch of ${dids.length})`
    );
    return [];
  }
  const body = (await res.json()) as { views?: LabelerView[] };
  return body.views ?? [];
}

// A single in-flight refresh per process; callers share it.
let refreshing: Promise<void> | null = null;

function refreshLabelers(): Promise<void> {
  if (refreshing) return refreshing;
  refreshing = doRefresh().finally(() => {
    refreshing = null;
  });
  return refreshing;
}

async function doRefresh(): Promise<void> {
  const { rows } = await bskyQuery<{ did: string }>(
    "SELECT did FROM bsky.labelers"
  );
  const dids = rows.map((r) => r.did);
  if (dids.length === 0) return;

  for (let i = 0; i < dids.length; i += GET_SERVICES_BATCH) {
    const batch = dids.slice(i, i + GET_SERVICES_BATCH);
    const views = await fetchServices(batch);
    for (const v of views) {
      const did = v.creator?.did;
      if (!did) continue;
      await bskyQuery(
        `UPDATE bsky.labelers
            SET handle = $2, display_name = $3, description = $4,
                avatar_url = $5, like_count = $6,
                enriched_at = now(), updated_at = now()
          WHERE did = $1`,
        [
          did,
          v.creator?.handle ?? null,
          v.creator?.displayName ?? null,
          v.creator?.description ?? null,
          v.creator?.avatar ?? null,
          v.likeCount ?? 0,
        ]
      );
    }
  }
}

/**
 * The labeler directory, most-liked first. Refreshes synchronously on first use
 * (fresh seed) and in the background when the cache is stale.
 */
export async function getLabelers(): Promise<Labeler[]> {
  let labelers = await readEnriched();
  if (labelers.length === 0) {
    await refreshLabelers();
    labelers = await readEnriched();
  } else if (await isStale()) {
    void refreshLabelers().catch((err) =>
      console.error("[labelers] background refresh failed:", err)
    );
  }
  return labelers;
}
