"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import PostCard from "@/components/PostCard";
import { CuratorProvider } from "@/app/curator/curatorContext";
import { FeedActionsProvider, useFeedActions } from "@/app/curator/feedActions";
import type { Post } from "@/app/curator/feedTypes";
import type { UserProfile } from "@/lib/types";
import type { GEFeedResponse } from "./types";
// The card styling lives in the curator stylesheet, which is only imported by
// the curator layout. Pull it in here so <PostCard> renders identically.
import "@/app/curator/curator.css";

// Throwaway prototype page: type a Bluesky handle, tune the Green Earth
// recommendation pipeline live, and render the resulting feed with the REAL
// curator <PostCard> (wrapped in the same providers it expects). Isolated at
// /greenearth — nothing else is touched.

const GENERATOR_NAMES = [
  "popularity",
  "post_similarity",
  "followed_users",
  "network_likes",
  "random_posts",
];

const RANKERS = ["none", "two_tower", "heavy_ranker", "candidate_score", "perspective"];

const ANON_PROFILE: UserProfile = {
  uid: "",
  name: "Anonymous",
  email: "",
  photoURL: "",
  blueskyHandle: "",
  blueskyDid: "",
  bskyAppPassword: "",
  onboardedAt: "",
};

interface GenState {
  name: string;
  enabled: boolean;
  weight: number;
}

const DEFAULT_GENERATORS: GenState[] = GENERATOR_NAMES.map((name) => ({
  name,
  enabled: name === "popularity" || name === "post_similarity" || name === "followed_users",
  weight: name === "popularity" ? 2 : 1,
}));

// Renders the real PostCards. Must live inside FeedActionsProvider so it can
// register posts for quote + AI-label hydration.
function FeedList({ posts }: { posts: Post[] }) {
  const { trackPosts } = useFeedActions();
  useEffect(() => {
    if (posts.length) trackPosts(posts);
  }, [posts, trackPosts]);
  return (
    <div className="ge-feed">
      {posts.map((p) => (
        <PostCard key={p.uri} post={p} />
      ))}
    </div>
  );
}

export default function GreenEarthPage() {
  const [handle, setHandle] = useState("");
  const [generators, setGenerators] = useState<GenState[]>(DEFAULT_GENERATORS);
  const [ranker, setRanker] = useState("two_tower");
  const [diversify, setDiversify] = useState(true);
  const [numCandidates, setNumCandidates] = useState(50);
  const [videoOnly, setVideoOnly] = useState(false);

  const [posts, setPosts] = useState<Post[]>([]);
  const [stages, setStages] = useState<string[]>([]);
  const [resolvedDid, setResolvedDid] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Curator context state that PostCard / FeedActionsProvider actually read.
  const [profile, setProfile] = useState<UserProfile>(ANON_PROFILE);
  const [bskyOAuthReady, setBskyOAuthReady] = useState(false);
  const [showDebug, setShowDebug] = useState(true);

  const fetchProfile = useCallback(async () => {
    try {
      const res = await fetch("/api/user");
      if (!res.ok) return;
      const data = await res.json();
      const row = data.user;
      if (row) {
        setProfile({
          uid: row.id || "",
          name: row.name || "Anonymous",
          email: row.email || "",
          photoURL: row.photo_url || "",
          blueskyHandle: row.bluesky_handle || "",
          blueskyDid: row.bluesky_did || "",
          bskyAppPassword: row.bsky_app_password ? "••••" : "",
          onboardedAt: row.created_at || "",
        });
        setBskyOAuthReady(!!data.oauthReady);
      }
    } catch {
      /* anonymous profile is fine */
    }
  }, []);

  useEffect(() => {
    fetchProfile();
  }, [fetchProfile]);

  // The handle the current results were loaded for — auto-rerun (on pipeline
  // control changes) targets this, so tweaking controls before ever loading a
  // feed does nothing.
  const loadedHandle = useRef<string | null>(null);

  const run = useCallback(
    async (targetHandle: string) => {
      const h = targetHandle.trim();
      if (!h) return;
      setLoading(true);
      setError(null);
      try {
        const res = await fetch("/api/green-earth", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            handle: h,
            generators: generators
              .filter((g) => g.enabled && g.weight > 0)
              .map((g) => ({ name: g.name, weight: g.weight })),
            ranker,
            diversify,
            numCandidates,
            videoOnly,
          }),
        });
        const json = (await res.json()) as GEFeedResponse & { error?: string };
        if (!res.ok) throw new Error(json.error || `Request failed (${res.status})`);
        setPosts(json.posts);
        setStages(json.stages);
        setResolvedDid(json.did);
        loadedHandle.current = h;
      } catch (e) {
        setError(e instanceof Error ? e.message : "Something went wrong");
        setPosts([]);
        setStages([]);
      } finally {
        setLoading(false);
      }
    },
    [generators, ranker, diversify, numCandidates, videoOnly]
  );

  // Re-run on pipeline control changes, but only once a feed has been loaded.
  useEffect(() => {
    if (!loadedHandle.current) return;
    const t = setTimeout(() => run(loadedHandle.current as string), 450);
    return () => clearTimeout(t);
  }, [generators, ranker, diversify, numCandidates, videoOnly, run]);

  const toggleGen = (name: string) =>
    setGenerators((gs) => gs.map((g) => (g.name === name ? { ...g, enabled: !g.enabled } : g)));
  const setGenWeight = (name: string, weight: number) =>
    setGenerators((gs) => gs.map((g) => (g.name === name ? { ...g, weight } : g)));

  const noop = () => {};
  const asyncNoop = async () => {};
  const curatorValue = {
    profile,
    bskyOAuthReady,
    refreshProfile: fetchProfile,
    feeds: [],
    reloadFeeds: asyncNoop,
    activePostCount: posts.length,
    setActivePostCount: noop,
    mobileTab: "feed" as const,
    setMobileTab: noop,
    optionsUnread: false,
    setOptionsUnread: noop,
    viewMode: "card" as const,
    setViewMode: noop,
    showDebug,
    setShowDebug,
    hideUnavailable: false,
    setHideUnavailable: noop,
    hideSeen: false,
    setHideSeen: noop,
    unavailableCount: 0,
    setUnavailableCount: noop,
    sidebarOpen: false,
    setSidebarOpen: noop,
    openPublish: noop,
    openTune: noop,
    registerOpenTune: noop,
  };

  return (
    <div className="ge-page">
      <style>{CSS}</style>

      <header className="ge-header">
        <h1>
          <span className="ge-leaf">🌍</span> Green Earth feed{" "}
          <span className="ge-tag">prototype</span>
        </h1>
        <p className="ge-sub">
          Personalized Bluesky recommendations from the Green Earth API, rendered with the curator
          PostCard. Type a handle and tune the pipeline.
        </p>
      </header>

      <div className="ge-controls">
        <div className="ge-row">
          <label className="ge-field ge-grow">
            <span>Bluesky handle</span>
            <input
              type="text"
              placeholder="e.g. bsky.app or alice.bsky.social"
              value={handle}
              onChange={(e) => setHandle(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") run(handle);
              }}
            />
          </label>
          <button
            className="ge-load"
            onClick={() => run(handle)}
            disabled={loading || !handle.trim()}
          >
            {loading ? "Loading…" : "Load feed"}
          </button>
        </div>

        <div className="ge-row ge-gens">
          {generators.map((g) => (
            <div key={g.name} className={`ge-gen${g.enabled ? " on" : ""}`}>
              <label className="ge-gen-toggle">
                <input type="checkbox" checked={g.enabled} onChange={() => toggleGen(g.name)} />
                <span>{g.name}</span>
              </label>
              <input
                className="ge-weight"
                type="number"
                min={0.5}
                step={0.5}
                value={g.weight}
                disabled={!g.enabled}
                onChange={(e) => setGenWeight(g.name, Number(e.target.value))}
                title="Relative weight"
              />
            </div>
          ))}
        </div>

        <div className="ge-row ge-opts">
          <label className="ge-field">
            <span>Ranker</span>
            <select value={ranker} onChange={(e) => setRanker(e.target.value)}>
              {RANKERS.map((r) => (
                <option key={r} value={r}>
                  {r}
                </option>
              ))}
            </select>
          </label>
          <label className="ge-field">
            <span>Candidates</span>
            <input
              type="number"
              min={10}
              max={200}
              step={10}
              value={numCandidates}
              onChange={(e) => setNumCandidates(Number(e.target.value))}
            />
          </label>
          <label className="ge-check">
            <input
              type="checkbox"
              checked={diversify}
              onChange={(e) => setDiversify(e.target.checked)}
            />
            <span>Diversify (MMR)</span>
          </label>
          <label className="ge-check">
            <input
              type="checkbox"
              checked={videoOnly}
              onChange={(e) => setVideoOnly(e.target.checked)}
            />
            <span>Video only</span>
          </label>
          <label className="ge-check">
            <input
              type="checkbox"
              checked={showDebug}
              onChange={(e) => setShowDebug(e.target.checked)}
            />
            <span>Show scores</span>
          </label>
        </div>

        {(resolvedDid || stages.length > 0) && (
          <div className="ge-status">
            {resolvedDid && <code>{resolvedDid}</code>}
            {stages.length > 0 && <span className="ge-stages">{stages.join("  ·  ")}</span>}
          </div>
        )}
      </div>

      {error && <div className="ge-error">⚠ {error}</div>}

      {!error && !loading && posts.length === 0 && loadedHandle.current && (
        <div className="ge-empty">No posts returned for this configuration.</div>
      )}

      {!error && !loadedHandle.current && !loading && (
        <div className="ge-empty">Enter a handle and press Load feed to start.</div>
      )}

      <CuratorProvider value={curatorValue}>
        <FeedActionsProvider>
          <FeedList posts={posts} />
        </FeedActionsProvider>
      </CuratorProvider>
    </div>
  );
}

const CSS = `
.ge-page { max-width: 620px; margin: 0 auto; padding: 24px 16px 80px; }
.ge-header h1 { font-size: 24px; margin: 0 0 4px; display: flex; align-items: center; gap: 8px; }
.ge-leaf { font-size: 22px; }
.ge-tag { font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: .5px;
  background: #d7f2d9; color: #1a7f37; padding: 2px 8px; border-radius: 20px; }
.ge-sub { color: #666; margin: 0 0 18px; font-size: 14px; }
.ge-controls { background: #f6f8fa; border: 1px solid #e2e6ea; border-radius: 12px;
  padding: 14px; margin-bottom: 22px; display: flex; flex-direction: column; gap: 12px; }
.ge-row { display: flex; gap: 10px; flex-wrap: wrap; align-items: flex-end; }
.ge-field { display: flex; flex-direction: column; gap: 4px; font-size: 12px; color: #555; }
.ge-field span { font-weight: 600; }
.ge-grow { flex: 1; min-width: 200px; }
.ge-field input, .ge-field select { padding: 8px 10px; border: 1px solid #cfd6dd; border-radius: 8px;
  font-size: 14px; background: #fff; }
.ge-load { padding: 9px 18px; border: none; border-radius: 8px; background: #1a7f37; color: #fff;
  font-weight: 600; font-size: 14px; cursor: pointer; }
.ge-load:disabled { opacity: .55; cursor: default; }
.ge-gens { gap: 8px; }
.ge-gen { display: flex; align-items: center; gap: 6px; background: #fff; border: 1px solid #cfd6dd;
  border-radius: 8px; padding: 5px 8px; font-size: 13px; opacity: .6; }
.ge-gen.on { opacity: 1; border-color: #1a7f37; }
.ge-gen-toggle { display: flex; align-items: center; gap: 5px; cursor: pointer; }
.ge-weight { width: 52px; padding: 3px 5px; border: 1px solid #cfd6dd; border-radius: 6px; font-size: 13px; }
.ge-opts { align-items: center; }
.ge-check { display: flex; align-items: center; gap: 6px; font-size: 13px; color: #444; cursor: pointer; }
.ge-status { display: flex; flex-wrap: wrap; gap: 10px; align-items: center; font-size: 12px; color: #777;
  border-top: 1px dashed #d7dde3; padding-top: 10px; }
.ge-status code { background: #eef1f4; padding: 2px 6px; border-radius: 5px; font-size: 11px; }
.ge-stages { color: #1a7f37; font-weight: 500; }
.ge-error { background: #fff0f0; border: 1px solid #f3c2c2; color: #b32020; padding: 12px 14px;
  border-radius: 10px; margin-bottom: 18px; font-size: 14px; }
.ge-empty { color: #888; text-align: center; padding: 40px 0; font-size: 14px; }
.ge-feed { display: flex; flex-direction: column; gap: 14px; }
`;
