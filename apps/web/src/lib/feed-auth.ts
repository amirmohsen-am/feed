/**
 * Verify the atproto service-auth JWT on a getFeedSkeleton request and return
 * the requesting user's DID.
 *
 * When the Bluesky AppView proxies a logged-in user's feed request to a feed
 * generator, it attaches `Authorization: Bearer <jwt>` where the JWT is signed
 * by the *requesting user's* repo signing key. Verifying it lets us identify
 * who is asking — required for per-subscriber seen filtering.
 *
 *   iss  → the requesting user's DID (what we want)
 *   aud  → must equal our feed-generator service DID (did:web:<host>)
 *   lxm  → the bound lexicon method (app.bsky.feed.getFeedSkeleton)
 *
 * verifyJwt resolves the issuer's atproto signing key (via the PLC directory /
 * did:web) and checks the signature, audience, expiry, and method binding.
 *
 * Fail-soft: any missing/invalid token returns null. The caller treats a null
 * requester as anonymous and serves the unfiltered shared snapshot — never an
 * error, since the JWT is optional and most third-party clients won't send one.
 */

import { verifyJwt } from "@atproto/xrpc-server";
import { IdResolver } from "@atproto/identity";
import { getFeedgenServiceDid } from "./feedgen";

const GET_FEED_SKELETON_NSID = "app.bsky.feed.getFeedSkeleton";

let _idResolver: IdResolver | null = null;
function idResolver(): IdResolver {
  if (!_idResolver) _idResolver = new IdResolver();
  return _idResolver;
}

/** Returns the requester's DID, or null when there is no valid token. */
export async function verifyFeedRequesterDid(
  authorizationHeader: string | null
): Promise<string | null> {
  if (!authorizationHeader?.startsWith("Bearer ")) return null;
  const jwt = authorizationHeader.slice("Bearer ".length).trim();
  if (!jwt) return null;

  try {
    const payload = await verifyJwt(
      jwt,
      getFeedgenServiceDid(),
      GET_FEED_SKELETON_NSID,
      async (did, forceRefresh) =>
        idResolver().did.resolveAtprotoKey(did, forceRefresh)
    );
    return payload.iss ?? null;
  } catch (e) {
    // Expired / wrong audience / unresolvable DID / bad signature — all benign
    // here; the request is simply treated as anonymous.
    console.warn(
      "[feed-auth] service JWT verification failed (serving anonymous):",
      e instanceof Error ? e.message : String(e)
    );
    return null;
  }
}
