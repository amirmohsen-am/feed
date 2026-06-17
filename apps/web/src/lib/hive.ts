import { getSecret } from "./secrets";
import { getCachedImageLabels, upsertImageLabels, type CachedImageLabel } from "./pg";

const HIVE_API_URL =
  "https://api.thehive.ai/api/v3/hive/ai-generated-and-deepfake-content-detection";

export interface HiveImageResult {
  ai_generated: boolean;
  score: number;
}

export interface HivePostResult {
  ai_generated: boolean;
  scores: number[];
  error?: boolean;
}

async function getHiveApiKey(): Promise<string | null> {
  try {
    return await getSecret("hive-api-key");
  } catch {
    console.warn("[hive] No Hive API key configured — AI labeling disabled");
    return null;
  }
}

/**
 * Check a single media URL against Hive's v3 AI-generated content detection.
 * Works for both images and video thumbnails (any image URL).
 *
 * Returns `null` on a transient failure (HTTP error / unparseable response) so
 * the caller does NOT cache it — a successful 200 (even "not flagged") is a
 * real, cacheable classification; a failure must stay retryable.
 */
export async function checkImageAiGenerated(
  imageUrl: string,
  apiKey: string
): Promise<HiveImageResult | null> {
  const res = await fetch(HIVE_API_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      input: [{ media_url: imageUrl }],
    }),
  });

  if (!res.ok) {
    console.warn(`[hive] API returned ${res.status} for ${imageUrl}`);
    return null;
  }

  const json = await res.json();

  // v3 response: { output: [{ classes: [{ class, value }, ...] }] }
  try {
    const outputs = json?.output ?? [];
    for (const output of outputs) {
      for (const cls of output.classes ?? []) {
        if (cls.class === "ai_generated") {
          const score = typeof cls.value === "number" ? cls.value : 0;
          return { ai_generated: score >= 0.5, score };
        }
      }
    }
  } catch (e) {
    console.warn("[hive] Failed to parse response:", e);
    return null;
  }

  // 200 but no ai_generated class in the payload — a definitive "not flagged",
  // safe to cache.
  return { ai_generated: false, score: 0 };
}

/**
 * Check all images in a post for AI-generated content. Returns true if
 * *any* image scores above the threshold.
 *
 * Cached per image URL in `ai_image_labels` (feed-db): Bluesky image URLs are
 * content-addressed, so each unique image hits the paid Hive API at most once,
 * ever, across all users. Only cache-misses call Hive.
 *
 * Fail-soft: returns `error: true` when the API key is missing or any uncached
 * image failed to classify (those are left uncached so they retry next time).
 */
export async function checkPostMedia(
  imageUrls: string[]
): Promise<HivePostResult> {
  if (imageUrls.length === 0) {
    return { ai_generated: false, scores: [] };
  }

  // 1) Serve from cache where possible. Fail-soft: if the cache read errors
  //    (e.g. the migration hasn't been applied yet, or a transient DB blip),
  //    degrade to treating everything as a miss rather than breaking labeling.
  let cached: Map<string, CachedImageLabel>;
  try {
    cached = await getCachedImageLabels(imageUrls);
  } catch (e) {
    console.warn("[hive] cache read failed — treating all as misses:", e);
    cached = new Map();
  }
  const misses = imageUrls.filter((u) => !cached.has(u));

  // 2) Classify only the misses via Hive (if a key is configured).
  let failed = false;
  if (misses.length > 0) {
    const apiKey = await getHiveApiKey();
    if (!apiKey) {
      // Can't classify the misses; return whatever the cache had, flagged soft.
      const scores = imageUrls.map((u) => cached.get(u)?.score ?? 0);
      const ai_generated = imageUrls.some(
        (u) => cached.get(u)?.ai_generated ?? false
      );
      return { ai_generated, scores, error: true };
    }

    const fresh = await Promise.all(
      misses.map((url) =>
        checkImageAiGenerated(url, apiKey).catch((e) => {
          console.warn("[hive] checkImage failed:", e);
          return null;
        })
      )
    );

    const toCache: Array<{ url: string; ai_generated: boolean; score: number }> =
      [];
    misses.forEach((url, i) => {
      const r = fresh[i];
      if (r) {
        cached.set(url, r);
        toCache.push({ url, ai_generated: r.ai_generated, score: r.score });
      } else {
        failed = true; // leave uncached so it retries on a later view
      }
    });
    // Persist successes; a cache write failure must not break labeling.
    await upsertImageLabels(toCache).catch((e) =>
      console.warn("[hive] cache upsert failed:", e)
    );
  }

  // 3) Compose the per-post result from the (now-populated) cache map.
  const scores = imageUrls.map((u) => cached.get(u)?.score ?? 0);
  const ai_generated = imageUrls.some(
    (u) => cached.get(u)?.ai_generated ?? false
  );

  return failed ? { ai_generated, scores, error: true } : { ai_generated, scores };
}
