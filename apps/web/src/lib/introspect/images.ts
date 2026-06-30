/**
 * Image fetcher for vision-attached engagements.
 *
 * The Bluesky CDN serves post images at:
 *   https://cdn.bsky.app/img/feed_fullsize/plain/<did>/<cid>@jpeg
 *
 * For vision we want feed_thumbnail (smaller, cheaper) — Claude rescales
 * anything larger anyway, so paying for the fullsize bytes is wasted.
 *
 * Cached to apps/web/.local-data/introspect/_images/<sha>.jpg. Cache hits
 * skip the CDN round-trip and the base64 re-encoding.
 */

import { mkdir, readFile, writeFile, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";

const CDN_BASE = "https://cdn.bsky.app/img/feed_thumbnail/plain";
// Resolved relative to the Next.js process cwd (apps/web/).
const IMAGE_DIR = ".local-data/introspect/_images";

let _dirReady = false;
async function ensureDir() {
  if (_dirReady) return;
  await mkdir(IMAGE_DIR, { recursive: true });
  _dirReady = true;
}

function keyFor(authorDid: string, cid: string): string {
  return createHash("sha256").update(`${authorDid}/${cid}`).digest("hex");
}

export interface CachedImage {
  /** Raw bytes — used by the Anthropic SDK base64 image source. */
  bytes: Buffer;
  /** "image/jpeg" — Bluesky CDN always returns jpeg at this endpoint. */
  mediaType: "image/jpeg";
}

/**
 * Fetch one image, with on-disk caching. Returns null on any failure so the
 * caller can drop the image and keep the engagement record (per design §6.4).
 */
async function fetchImage(
  authorDid: string,
  cid: string
): Promise<CachedImage | null> {
  await ensureDir();
  const key = keyFor(authorDid, cid);
  const path = join(IMAGE_DIR, `${key}.jpg`);

  try {
    const s = await stat(path);
    if (s.size > 0) {
      const bytes = await readFile(path);
      return { bytes, mediaType: "image/jpeg" };
    }
  } catch {
    // not cached yet
  }

  const url = `${CDN_BASE}/${authorDid}/${cid}@jpeg`;
  try {
    const res = await fetch(url);
    if (!res.ok) {
      console.warn(
        `[introspect.images] CDN ${res.status} for ${authorDid}/${cid}`
      );
      return null;
    }
    const arr = new Uint8Array(await res.arrayBuffer());
    const bytes = Buffer.from(arr);
    await writeFile(path, bytes);
    return { bytes, mediaType: "image/jpeg" };
  } catch (err) {
    console.warn(
      `[introspect.images] fetch threw for ${authorDid}/${cid}:`,
      err instanceof Error ? err.message : err
    );
    return null;
  }
}

/** Fetch many images in parallel. Failures become nulls in the output map. */
export async function fetchImages(
  refs: Array<{ authorDid: string; cid: string }>
): Promise<Map<string, CachedImage>> {
  const out = new Map<string, CachedImage>();
  // Bound concurrency to be polite to the CDN. 8 is a safe number for ~150
  // images: ~20 batches, ~5–10s total.
  const CONCURRENCY = 8;
  let i = 0;
  await Promise.all(
    Array.from({ length: CONCURRENCY }, async () => {
      while (i < refs.length) {
        const j = i++;
        const r = refs[j];
        const img = await fetchImage(r.authorDid, r.cid);
        if (img) out.set(`${r.authorDid}/${r.cid}`, img);
      }
    })
  );
  return out;
}

export function imageKey(authorDid: string, cid: string): string {
  return `${authorDid}/${cid}`;
}
