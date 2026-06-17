/**
 * Bluesky custom feed generator (did:web service) helpers.
 *
 * The app acts as a feed generator service at did:web:{hostname}. Users
 * publish app.bsky.feed.generator records on their own repos pointing here;
 * Bluesky calls our xrpc endpoints to fetch post skeletons.
 */

export function getFeedgenHostname(): string {
  if (process.env.FEEDGEN_HOSTNAME) return process.env.FEEDGEN_HOSTNAME;
  const base = process.env.NEXT_PUBLIC_URL || process.env.NEXTAUTH_URL;
  if (base) {
    try {
      return new URL(base).hostname;
    } catch {
      /* fall through */
    }
  }
  return "localhost";
}

export function getFeedgenServiceDid(): string {
  return `did:web:${getFeedgenHostname()}`;
}

const LOCAL_HOSTNAMES = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** Bluesky must resolve did:web over the public internet — local dev hostnames won't work. */
export function isFeedgenPublishable(): boolean {
  return !LOCAL_HOSTNAMES.has(getFeedgenHostname());
}

export function feedgenPublishBlockedMessage(): string {
  const hostname = getFeedgenHostname();
  const prod = process.env.FEEDGEN_HOSTNAME || "amadi.social";
  return (
    `Feeds cannot be published from ${hostname} — Bluesky cannot reach a local dev server. ` +
    `Publish from https://${prod} instead (or set FEEDGEN_HOSTNAME for a public tunnel URL).`
  );
}

/** Stable, unique rkey for a feed row — safe to re-publish (updates in place). */
export function feedGeneratorRkey(feedId: number): string {
  return `ripple-${feedId}`;
}

/** Parse at://did/.../app.bsky.feed.generator/{rkey} from a feed URI param. */
export function parseFeedGeneratorUri(
  feedUri: string
): { publisherDid: string; rkey: string } | null {
  const m = feedUri.match(
    /^at:\/\/([^/]+)\/app\.bsky\.feed\.generator\/([^/?#]+)$/
  );
  if (!m) return null;
  return { publisherDid: m[1], rkey: m[2] };
}
