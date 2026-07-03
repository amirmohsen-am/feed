/**
 * Client-side stash for the action that triggered a "connect Bluesky" flow
 * (a like, repost, publish, ...), so it can auto-complete when the user lands
 * back from OAuth with `?bsky_connected=1`.
 *
 * sessionStorage is per-tab and survives the same-tab OAuth redirect; user
 * attribution across the redirect is handled server-side by the
 * bsky_oauth_state row, so nothing here needs to be trusted.
 *
 * Abandonment safety: the stash is only consumed on a mount that carries
 * `bsky_connected=1`; every other curator mount discards it, and entries
 * expire after 10 minutes (matching the server's OAuth state TTL) so a tab
 * left open mid-flow can never fire a stale action.
 */

export type PendingAction =
  | { type: "like" | "repost" | "reply" | "quote"; uri: string }
  | { type: "publish"; feedId: number };

type StoredAction = PendingAction & { expiresAt: number };

const KEY = "ripple:pendingBskyAction";
export const PENDING_ACTION_TTL_MS = 10 * 60 * 1000;

export function stashPendingAction(action: PendingAction): void {
  if (typeof window === "undefined") return;
  try {
    const stored: StoredAction = {
      ...action,
      expiresAt: Date.now() + PENDING_ACTION_TTL_MS,
    };
    window.sessionStorage.setItem(KEY, JSON.stringify(stored));
  } catch {
    /* storage unavailable (private mode quota etc.) — action just won't resume */
  }
}

/** Read and delete the stashed action. Returns null if absent or expired. */
export function takePendingAction(): PendingAction | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.sessionStorage.getItem(KEY);
    window.sessionStorage.removeItem(KEY);
    if (!raw) return null;
    const stored = JSON.parse(raw) as StoredAction;
    if (!stored || typeof stored !== "object") return null;
    if (typeof stored.expiresAt !== "number" || stored.expiresAt < Date.now()) {
      return null;
    }
    delete (stored as Partial<StoredAction>).expiresAt;
    return stored as PendingAction;
  } catch {
    return null;
  }
}

export function discardPendingAction(): void {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.removeItem(KEY);
  } catch {
    /* ignore */
  }
}
