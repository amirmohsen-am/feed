import { useCallback, useEffect, useMemo, useRef } from "react";
import { authedFetch } from "@/lib/authed-fetch";

/**
 * Client-side "seen" tracking for the curator preview feed, mirroring how the
 * Bluesky app marks posts seen (src/view/com/util/List.web.tsx in social-app):
 * a post counts as seen once it has been genuinely on screen for a sustained
 * dwell, not merely served. Impressions are deduped per load generation,
 * batched, and POSTed to /api/seen (→ recordSeen).
 *
 * Thresholds match Bluesky:
 *   - ROOT_MARGIN: the post must sit ~200px inside the viewport (well past the
 *     top/bottom edges) to be considered visible.
 *   - DWELL_MS: it must stay visible continuously for 500ms; scrolling it away
 *     sooner cancels the timer, so a fast scroll-past does not count.
 * Flush cadence is faster than Bluesky's 10s (FLUSH_MS) so that a Refresh —
 * which always flushNow()s first — has little to wait for and the reload's
 * server-side seen filter sees the impressions just recorded.
 */
const DWELL_MS = 500;
const ROOT_MARGIN = "-200px 0px -200px 0px";
const FLUSH_MS = 2000;
const MAX_BATCH = 200;

export interface SeenTracker {
  /** Stable callback ref to attach to each post element, keyed by its uri. */
  register: (uri: string) => (node: HTMLElement | null) => void;
  /**
   * Flush queued impressions immediately and await the write. Call before a
   * refresh so just-seen posts are recorded before the reload re-filters.
   */
  flushNow: () => Promise<void>;
  /** Start a new load generation: clear per-fetch impression dedup. */
  reset: () => void;
}

export function useSeenTracker(feedId: number, enabled: boolean): SeenTracker {
  const queue = useRef<Set<string>>(new Set());
  const fired = useRef<Set<string>>(new Set());
  const observerRef = useRef<IntersectionObserver | null>(null);
  const elTimers = useRef<Map<Element, ReturnType<typeof setTimeout>>>(new Map());
  const elToUri = useRef<Map<Element, string>>(new Map());
  const uriToEl = useRef<Map<string, Element>>(new Map());
  const refCache = useRef<Map<string, (n: HTMLElement | null) => void>>(new Map());
  const flushTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  // feedId is constant per mount — the workbench is keyed by feedId, so a feed
  // switch remounts this hook rather than changing the prop.
  const flush = useCallback(async (keepalive = false) => {
    if (flushTimer.current) {
      clearTimeout(flushTimer.current);
      flushTimer.current = undefined;
    }
    const uris = Array.from(queue.current);
    if (uris.length === 0) return;
    queue.current.clear();
    try {
      await authedFetch("/api/seen", {
        method: "POST",
        body: JSON.stringify({ feedId, uris }),
        keepalive,
        suppressErrorToast: true,
      });
    } catch {
      // Re-queue so the next flush retries (best-effort, idempotent server-side).
      uris.forEach((u) => queue.current.add(u));
    }
  }, [feedId]);

  const scheduleFlush = useCallback(() => {
    if (flushTimer.current) return;
    flushTimer.current = setTimeout(() => {
      flushTimer.current = undefined;
      void flush();
    }, FLUSH_MS);
  }, [flush]);

  // (Re)build the IntersectionObserver when the feature toggles. Observing only
  // happens while enabled, so a feed with seen filtering off records nothing.
  useEffect(() => {
    if (!enabled) {
      observerRef.current = null;
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const el = entry.target;
          if (entry.isIntersecting) {
            if (!elTimers.current.has(el)) {
              const t = setTimeout(() => {
                elTimers.current.delete(el);
                const uri = elToUri.current.get(el);
                if (uri && !fired.current.has(uri)) {
                  fired.current.add(uri);
                  queue.current.add(uri);
                  if (queue.current.size >= MAX_BATCH) void flush();
                  else scheduleFlush();
                }
              }, DWELL_MS);
              elTimers.current.set(el, t);
            }
          } else {
            const t = elTimers.current.get(el);
            if (t) {
              clearTimeout(t);
              elTimers.current.delete(el);
            }
          }
        }
      },
      { rootMargin: ROOT_MARGIN }
    );
    observerRef.current = observer;
    // Pick up elements registered before the observer existed.
    for (const el of uriToEl.current.values()) observer.observe(el);
    const timers = elTimers.current;
    return () => {
      observer.disconnect();
      observerRef.current = null;
      for (const t of timers.values()) clearTimeout(t);
      timers.clear();
    };
  }, [enabled, flush, scheduleFlush]);

  // Flush on tab hide / page unload so trailing impressions aren't lost.
  useEffect(() => {
    if (!enabled) return;
    const onVisibility = () => {
      if (document.visibilityState === "hidden") void flush(true);
    };
    const onPageHide = () => void flush(true);
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("pagehide", onPageHide);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("pagehide", onPageHide);
    };
  }, [enabled, flush]);

  // Flush on unmount (a feed switch remounts the workbench) so the last few
  // seconds of impressions before leaving the feed are still recorded.
  useEffect(() => {
    return () => {
      void flush(true);
    };
  }, [flush]);

  const register = useCallback((uri: string) => {
    let cb = refCache.current.get(uri);
    if (!cb) {
      cb = (node: HTMLElement | null) => {
        const obs = observerRef.current;
        const prev = uriToEl.current.get(uri);
        if (prev && prev !== node) {
          obs?.unobserve(prev);
          const t = elTimers.current.get(prev);
          if (t) {
            clearTimeout(t);
            elTimers.current.delete(prev);
          }
          elToUri.current.delete(prev);
          uriToEl.current.delete(uri);
        }
        if (node) {
          uriToEl.current.set(uri, node);
          elToUri.current.set(node, uri);
          obs?.observe(node);
        }
      };
      refCache.current.set(uri, cb);
    }
    return cb;
  }, []);

  const reset = useCallback(() => {
    fired.current.clear();
  }, []);

  const flushNow = useCallback(() => flush(), [flush]);

  return useMemo(
    () => ({ register, flushNow, reset }),
    [register, flushNow, reset]
  );
}
