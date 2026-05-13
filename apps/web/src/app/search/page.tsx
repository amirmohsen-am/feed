"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import Link from "next/link";
import Script from "next/script";
import "./search.css";
import { authedFetch } from "@/lib/authed-fetch";
import type { VectorHit } from "@/lib/vector-search";

declare global {
  interface Window {
    bluesky?: { scan: (root?: Element | Document) => void };
  }
}

// ---------- shared types ----------

interface RerankPrompt {
  id: string;
  name: string;
  current_version: number | null;
  current_system_prompt: string | null;
}

interface RunSummary {
  id: string;
  query: string;
  vector_k: number;
  rerank_k: number;
  rerank_enabled: boolean;
  ms_total: number | null;
  created_at: string;
}

interface VectorPhase {
  phase: "vector";
  model: string;
  rerank_enabled: boolean;
  prompt: { id: string; version: number; name: string } | null;
  ms: { vector: number };
  hits: VectorHit[];
  error?: string;
}

interface RerankPhase {
  phase: "rerank";
  ms: { rerank: number | null; total: number };
  kept: { i: number; score: number; reason: string }[] | null;
  error?: string;
}

// ---------- constants ----------

const ACTIVE_PROMPT_KEY = "search:activePromptId";

// ---------- helpers ----------

function atUriToBskyUrl(uri: string): string | null {
  const m = uri.match(/^at:\/\/([^/]+)\/app\.bsky\.feed\.post\/(.+)$/);
  if (!m) return null;
  return `https://bsky.app/profile/${m[1]}/post/${m[2]}`;
}

function timeAgo(iso: string): string {
  const d = new Date(iso).getTime();
  const diff = Date.now() - d;
  const s = Math.round(diff / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const days = Math.round(h / 24);
  return `${days}d ago`;
}

// ---------- bsky embed (script-injected, same approach as curator) ----------

function BskyEmbed({ uri }: { uri: string }) {
  const fallbackUrl = atUriToBskyUrl(uri);
  // Bluesky's embed.js replaces the inner `.bluesky-embed` element with an
  // iframe in place; keep the outer wrapper so our CSS overrides survive
  // the transform.
  return (
    <div className="srch-embed-wrap">
      <div
        className="bluesky-embed"
        data-bluesky-uri={uri}
        data-bluesky-embed-color-mode="light"
      >
        <p className="srch-embed-loading">loading post…</p>
        {fallbackUrl && (
          <p>
            <a href={fallbackUrl} target="_blank" rel="noopener noreferrer">
              View on Bluesky
            </a>
          </p>
        )}
      </div>
    </div>
  );
}

// ---------- result row ----------

interface RowProps {
  hit: VectorHit;
  vectorRank: number;
  vectorTotal: number;
  rerankerScore: number | null;
  rerankerRank: number | null;
  rerankerTotal: number | null;
  reason: string | null;
  rerankEnabled: boolean;
}

function ResultRow(props: RowProps) {
  const { hit, vectorRank, vectorTotal, rerankerScore, rerankerRank, rerankerTotal, reason, rerankEnabled } = props;
  const bskyUrl = atUriToBskyUrl(hit.uri);

  return (
    <div className="srch-row">
      <BskyEmbed uri={hit.uri} />
      <div className="srch-info">
        <h6>Retrieval</h6>
        <div className="srch-info-grid">
          {rerankEnabled && (
            <>
              <span className="k">Reranker score</span>
              <span className={`v ${rerankerScore !== null ? "score" : "muted"}`}>
                {rerankerScore !== null ? rerankerScore : "—"}
              </span>
              <span className="k">Reranker rank</span>
              <span className={`v ${rerankerRank !== null ? "rank" : "muted"}`}>
                {rerankerRank !== null
                  ? `#${rerankerRank} / ${rerankerTotal}`
                  : "not in top set"}
              </span>
            </>
          )}
          <span className="k">Vector score</span>
          <span className="v score">{hit.vector_score.toFixed(3)}</span>
          <span className="k">Vector rank</span>
          <span className="v rank">{`#${vectorRank} / ${vectorTotal}`}</span>
        </div>

        {rerankEnabled && (
          <>
            <h6>Reason</h6>
            {reason ? (
              <div className="srch-reason">{reason}</div>
            ) : (
              <div className="srch-reason-empty">
                Reranker did not surface this item.
              </div>
            )}
          </>
        )}

        {bskyUrl && (
          <a
            className="srch-bsky-link"
            href={bskyUrl}
            target="_blank"
            rel="noopener noreferrer"
          >
            ↗ open on bsky.app
          </a>
        )}
      </div>
    </div>
  );
}

// ---------- main page ----------

export default function SearchPage() {
  const [query, setQuery] = useState("");
  const [vectorK, setVectorK] = useState(100);
  const [rerankK, setRerankK] = useState(25);
  const [rerankEnabled, setRerankEnabled] = useState(true);
  const [activePromptId, setActivePromptId] = useState<string | null>(null);
  const [prompts, setPrompts] = useState<RerankPrompt[]>([]);
  const [runs, setRuns] = useState<RunSummary[]>([]);
  const [activeRunId, setActiveRunId] = useState<string | null>(null);

  const [submitting, setSubmitting] = useState(false);
  const [phase, setPhase] = useState<"idle" | "vector" | "rerank" | "done">("idle");
  const [vectorPhase, setVectorPhase] = useState<VectorPhase | null>(null);
  const [rerankPhase, setRerankPhase] = useState<RerankPhase | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [tab, setTab] = useState<"rerank" | "vector">("rerank");
  const inputRef = useRef<HTMLInputElement>(null);

  // Initial fetch: prompts + recent runs. AuthGate (in the root layout)
  // guarantees Firebase auth has settled before this component mounts, so
  // authedFetch always has a valid token by the time we get here.
  useEffect(() => {
    (async () => {
      try {
        const [pRes, rRes] = await Promise.all([
          authedFetch("/api/rerank-prompts"),
          authedFetch("/api/search/runs"),
        ]);
        if (pRes.ok) {
          const data = await pRes.json();
          const arr: RerankPrompt[] = data.prompts || [];
          setPrompts(arr);
          let restored: string | null = null;
          try {
            const saved = localStorage.getItem(ACTIVE_PROMPT_KEY);
            if (saved && arr.some((p) => p.id === saved)) restored = saved;
          } catch {
            /* ignore (Safari private mode) */
          }
          if (restored) {
            setActivePromptId(restored);
            setRerankEnabled(true);
          } else {
            setRerankEnabled(false);
          }
        }
        if (rRes.ok) {
          const data = await rRes.json();
          setRuns(data.runs || []);
        }
      } catch {
        /* ignore */
      }
    })();
  }, []);

  // Persist active prompt selection across reloads.
  useEffect(() => {
    try {
      if (activePromptId) {
        localStorage.setItem(ACTIVE_PROMPT_KEY, activePromptId);
      } else {
        localStorage.removeItem(ACTIVE_PROMPT_KEY);
      }
    } catch {
      /* ignore */
    }
  }, [activePromptId]);

  // ⌘K / Ctrl-K to focus input
  useEffect(() => {
    function onKey(ev: KeyboardEvent) {
      if ((ev.metaKey || ev.ctrlKey) && ev.key.toLowerCase() === "k") {
        ev.preventDefault();
        inputRef.current?.focus();
        inputRef.current?.select();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const activePrompt = useMemo(
    () => prompts.find((p) => p.id === activePromptId) ?? null,
    [prompts, activePromptId]
  );

  // ---- main search ----
  const runSearch = useCallback(async () => {
    const q = query.trim();
    if (!q) return;
    if (rerankEnabled && !activePromptId) {
      setError("Pick a reranker prompt or turn the reranker off.");
      return;
    }

    setSubmitting(true);
    setPhase("vector");
    setVectorPhase(null);
    setRerankPhase(null);
    setError(null);
    setTab(rerankEnabled ? "rerank" : "vector");
    setActiveRunId(null);

    try {
      const res = await authedFetch("/api/search", {
        method: "POST",
        body: JSON.stringify({
          query: q,
          vector_k: vectorK,
          rerank_k: rerankK,
          rerank_enabled: rerankEnabled,
          prompt_id: rerankEnabled ? activePromptId : undefined,
        }),
      });
      if (!res.ok || !res.body) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || `HTTP ${res.status}`);
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let idx;
        while ((idx = buffer.indexOf("\n")) !== -1) {
          const line = buffer.slice(0, idx).trim();
          buffer = buffer.slice(idx + 1);
          if (!line) continue;
          let parsed: unknown;
          try {
            parsed = JSON.parse(line);
          } catch {
            continue;
          }
          if (typeof parsed !== "object" || parsed === null) continue;
          const obj = parsed as { phase?: string };
          if (obj.phase === "vector") {
            setVectorPhase(obj as unknown as VectorPhase);
            if (rerankEnabled) {
              setPhase("rerank");
            } else {
              setPhase("done");
            }
          } else if (obj.phase === "rerank") {
            setRerankPhase(obj as unknown as RerankPhase);
            setPhase("done");
          }
        }
      }
      // refresh runs list
      try {
        const rRes = await authedFetch("/api/search/runs");
        if (rRes.ok) {
          const data = await rRes.json();
          setRuns(data.runs || []);
        }
      } catch {
        /* ignore */
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setPhase("idle");
    } finally {
      setSubmitting(false);
    }
  }, [query, vectorK, rerankK, rerankEnabled, activePromptId]);

  // ---- replay a saved run ----
  const replayRun = useCallback(async (id: string) => {
    setActiveRunId(id);
    setSubmitting(true);
    setPhase("vector");
    setVectorPhase(null);
    setRerankPhase(null);
    setError(null);
    try {
      const res = await authedFetch(`/api/search/runs/${id}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      const hits = (data.hits || []).filter(
        (h: { missing?: boolean }) => !h.missing
      ) as VectorHit[];
      setQuery(data.query);
      setVectorK(data.vector_k);
      setRerankK(data.rerank_k);
      setRerankEnabled(data.rerank_enabled);
      setTab(data.rerank_enabled ? "rerank" : "vector");
      setVectorPhase({
        phase: "vector",
        model: "claude-sonnet-4-6",
        rerank_enabled: data.rerank_enabled,
        prompt: null,
        ms: { vector: 0 },
        hits,
      });
      setRerankPhase({
        phase: "rerank",
        ms: { rerank: data.ms_rerank, total: data.ms_total ?? 0 },
        kept: data.kept,
      });
      setPhase("done");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setPhase("idle");
    } finally {
      setSubmitting(false);
    }
  }, []);

  // ---- derived: which hits to render in which tab ----
  const hits = vectorPhase?.hits ?? [];
  const kept = rerankPhase?.kept ?? null;
  const keptByIdx = useMemo(() => {
    const m = new Map<number, { rank: number; score: number; reason: string }>();
    if (kept) {
      kept.forEach((k, rank) => {
        m.set(k.i, { rank: rank + 1, score: k.score, reason: k.reason });
      });
    }
    return m;
  }, [kept]);

  const rerankerTotal = kept?.length ?? null;
  const vectorTotal = hits.length;

  const rerankedRows: RowProps[] = useMemo(() => {
    if (!kept) return [];
    const out: RowProps[] = [];
    kept.forEach((k, rank) => {
      const hit = hits[k.i];
      if (!hit) return;
      out.push({
        hit,
        vectorRank: k.i + 1,
        vectorTotal,
        rerankerScore: k.score,
        rerankerRank: rank + 1,
        rerankerTotal,
        reason: k.reason,
        rerankEnabled: true,
      });
    });
    return out;
  }, [kept, hits, vectorTotal, rerankerTotal]);

  const vectorRows: RowProps[] = useMemo(() => {
    return hits.map((hit, idx) => {
      const rrk = keptByIdx.get(idx) ?? null;
      return {
        hit,
        vectorRank: idx + 1,
        vectorTotal,
        rerankerScore: rrk?.score ?? null,
        rerankerRank: rrk?.rank ?? null,
        rerankerTotal,
        reason: rrk?.reason ?? null,
        rerankEnabled: rerankEnabled,
      };
    });
  }, [hits, keptByIdx, vectorTotal, rerankerTotal, rerankEnabled]);

  const rowsToRender = tab === "rerank" ? rerankedRows : vectorRows;

  // Re-scan Bluesky embeds whenever the rendered rows change (script auto-scans
  // on first load; manual rescans cover subsequent React rerenders).
  useEffect(() => {
    if (rowsToRender.length === 0) return;
    const scan = () => window.bluesky?.scan?.();
    scan();
    const t = setTimeout(scan, 300);
    return () => clearTimeout(t);
  }, [rowsToRender]);

  const modelLabel = vectorPhase?.model ?? "claude-sonnet-4-6";
  const totalMs =
    rerankPhase?.ms.total ??
    (vectorPhase ? vectorPhase.ms.vector : null);

  return (
    <div className="srch-shell">
      <Script
        src="https://embed.bsky.app/static/embed.js"
        strategy="afterInteractive"
        onLoad={() => window.bluesky?.scan?.()}
      />
      {/* ── LEFT RAIL ── */}
      <aside className="srch-rail">
        <div className="srch-rail-head">
          <Link href="/">Ripple <em>/search</em></Link>
        </div>

        <div className="srch-section-label">Recent runs</div>
        {runs.length === 0 ? (
          <div style={{ fontSize: 12, color: "var(--ink-3)" }}>
            No runs yet.
          </div>
        ) : (
          runs.map((r) => (
            <button
              key={r.id}
              className={`srch-run-item ${activeRunId === r.id ? "active" : ""}`}
              onClick={() => replayRun(r.id)}
            >
              {r.query}
              <span className="srch-run-meta">
                {timeAgo(r.created_at)} · {r.vector_k}
                {r.rerank_enabled ? `→${r.rerank_k}` : " · vector only"}
              </span>
            </button>
          ))
        )}

        <div className="srch-section-label">Saved prompts</div>
        {prompts.length === 0 ? (
          <div style={{ fontSize: 12, color: "var(--ink-3)" }}>
            No prompts saved yet.
          </div>
        ) : (
          prompts.map((p) => (
            <button
              key={p.id}
              className={`srch-prompt-item ${
                activePromptId === p.id ? "active" : ""
              }`}
              onClick={() => {
                setActivePromptId(p.id);
                setRerankEnabled(true);
              }}
              title="Activate this prompt"
            >
              <span>{p.name}</span>
              <span className="tag">v{p.current_version ?? 1}</span>
            </button>
          ))
        )}
        <Link href="/search/prompts" className="srch-link">
          + New / manage prompts
        </Link>

        <div style={{ flex: 1 }} />
        <Link href="/" className="srch-link" style={{ marginTop: 24 }}>
          ← Back to Curator
        </Link>
      </aside>

      {/* ── CENTER ── */}
      <main className="srch-main">
        <div className="srch-input">
          <input
            ref={inputRef}
            type="text"
            placeholder="search for posts…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") runSearch();
            }}
            autoFocus
          />
          <button
            onClick={runSearch}
            disabled={
              submitting ||
              !query.trim() ||
              (rerankEnabled && !activePromptId)
            }
            title={
              rerankEnabled && !activePromptId
                ? "Reranker is on but no prompt is selected — create one in /search/prompts or turn the reranker off."
                : undefined
            }
          >
            {submitting ? "Searching…" : "Search"}
          </button>
        </div>
        <div className="srch-input-hint">
          <span>⏎ search · ⌘K focus</span>
          <span>
            {totalMs !== null && phase === "done"
              ? `total ${totalMs}ms`
              : phase === "vector"
              ? "running vector search…"
              : phase === "rerank"
              ? `vector ${vectorPhase?.ms.vector}ms · reranking…`
              : ""}
          </span>
        </div>

        {error && <div className="srch-error">{error}</div>}

        <div className="srch-tabs">
          <button
            className={`srch-tab ${tab === "rerank" ? "active" : ""}`}
            onClick={() => setTab("rerank")}
            disabled={!vectorPhase?.rerank_enabled}
          >
            Reranked{" "}
            <span className="tab-count">
              {rerankPhase?.kept?.length ?? (vectorPhase?.rerank_enabled ? "…" : "—")}
            </span>
          </button>
          <button
            className={`srch-tab ${tab === "vector" ? "active" : ""}`}
            onClick={() => setTab("vector")}
          >
            Vector <span className="tab-count">{hits.length || "…"}</span>
          </button>
          <span
            className={`srch-model-pill ${
              vectorPhase?.rerank_enabled ? "" : "muted"
            }`}
            title={vectorPhase?.rerank_enabled ? "reranker model" : "reranker disabled"}
          >
            {vectorPhase?.rerank_enabled ? modelLabel : "vector only"}
          </span>
        </div>

        {phase === "rerank" && tab === "rerank" && !rerankPhase && (
          <div className="srch-progress">
            <span className="pulse" />
            <span>
              Claude {modelLabel} reranking {hits.length} candidates…
            </span>
          </div>
        )}

        <div className="srch-results">
          {phase === "idle" && (
            <div className="srch-empty">
              Type a query above. Vector search runs first, then the reranker.
            </div>
          )}
          {phase !== "idle" && rowsToRender.length === 0 && phase === "done" && (
            <div className="srch-empty">
              {tab === "rerank"
                ? "Reranker kept no items."
                : "Vector search returned no hits."}
            </div>
          )}
          {rowsToRender.map((row) => (
            <ResultRow key={row.hit.uri} {...row} />
          ))}
        </div>
      </main>

      {/* ── RIGHT RAIL ── */}
      <aside className="srch-rail right">
        <div className="srch-section-label">Knobs</div>

        <div className="srch-knob">
          <div className="srch-knob-head">
            <span className="srch-knob-label">Vector returns</span>
            <span className="srch-knob-val">{vectorK}</span>
          </div>
          <input
            type="range"
            min={10}
            max={200}
            step={5}
            value={vectorK}
            onChange={(e) => setVectorK(Number(e.target.value))}
          />
          <div
            style={{
              fontSize: 11,
              color: "var(--ink-3)",
              fontFamily: "var(--rf-mono)",
              marginTop: 4,
            }}
          >
            10 – 200
          </div>
        </div>

        <div className="srch-knob" style={{ opacity: rerankEnabled ? 1 : 0.5 }}>
          <div className="srch-knob-head">
            <span className="srch-knob-label">Reranker keeps</span>
            <span className="srch-knob-val">{rerankK}</span>
          </div>
          <input
            type="range"
            min={1}
            max={50}
            step={1}
            value={rerankK}
            onChange={(e) => setRerankK(Number(e.target.value))}
            disabled={!rerankEnabled}
          />
          <div
            style={{
              fontSize: 11,
              color: "var(--ink-3)",
              fontFamily: "var(--rf-mono)",
              marginTop: 4,
            }}
          >
            1 – 50
          </div>
        </div>

        <button
          className={`srch-toggle ${rerankEnabled ? "on" : ""}`}
          onClick={() => {
            setRerankEnabled((v) => {
              const next = !v;
              // Turning on with no prompt selected → auto-pick the first
              // saved prompt so the search button isn't immediately gated.
              if (next && !activePromptId && prompts.length > 0) {
                setActivePromptId(prompts[0].id);
              }
              return next;
            });
          }}
          type="button"
        >
          <span className="srch-toggle-label">Use reranker</span>
          <span className="srch-toggle-track" />
        </button>

        {rerankEnabled && (
          <>
            <div className="srch-section-label">Active prompt</div>
            <select
              className="srch-select"
              value={activePromptId ?? ""}
              onChange={(e) => setActivePromptId(e.target.value || null)}
              disabled={prompts.length === 0}
            >
              <option value="">— none —</option>
              {prompts.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name} · v{p.current_version ?? 1}
                </option>
              ))}
            </select>
            {activePrompt ? (
              <div className="srch-prompt-preview" style={{ marginTop: 8 }}>
                <div className="srch-prompt-preview-body">
                  {activePrompt.current_system_prompt}
                </div>
                <div className="srch-prompt-preview-actions">
                  <Link
                    href={`/search/prompts?id=${activePrompt.id}`}
                    className="srch-link"
                    style={{ marginTop: 0 }}
                  >
                    Edit
                  </Link>
                  <Link
                    href="/search/prompts"
                    className="srch-link"
                    style={{ marginTop: 0 }}
                  >
                    + New
                  </Link>
                </div>
              </div>
            ) : (
              <div
                style={{
                  marginTop: 8,
                  fontSize: 12,
                  color: "var(--ink-3)",
                  lineHeight: 1.5,
                }}
              >
                {prompts.length === 0 ? (
                  <>
                    No prompts saved.{" "}
                    <Link href="/search/prompts" className="srch-link">
                      Create one →
                    </Link>
                  </>
                ) : (
                  "Pick a prompt above to enable the reranker."
                )}
              </div>
            )}
          </>
        )}

        <div className="srch-section-label" style={{ marginTop: 22 }}>
          Model
        </div>
        <div
          style={{
            fontFamily: "var(--rf-mono)",
            fontSize: 12,
            color: "var(--ink)",
            padding: "8px 12px",
            border: "1px solid var(--hair)",
            borderRadius: 6,
            background: "rgba(17,36,28,0.3)",
          }}
        >
          {rerankEnabled ? "claude-sonnet-4-6" : "vector only (no LLM)"}
        </div>

        <div className="srch-section-label" style={{ marginTop: 22 }}>
          Filters
        </div>
        <details className="srch-disclosure">
          <summary>Mechanical filters</summary>
          <div className="srch-disclosure-body">
            (lang, hashtags, min likes — coming soon)
          </div>
        </details>

        {phase === "done" && vectorPhase && (
          <>
            <div className="srch-section-label" style={{ marginTop: 22 }}>
              Timings
            </div>
            <div
              style={{
                fontFamily: "var(--rf-mono)",
                fontSize: 11.5,
                color: "var(--ink-2)",
                lineHeight: 1.7,
              }}
            >
              <div>
                vector{"  "}
                {vectorPhase.ms.vector}ms
              </div>
              {rerankPhase?.ms.rerank !== null &&
                rerankPhase?.ms.rerank !== undefined && (
                  <div>
                    rerank{"  "}
                    {rerankPhase.ms.rerank}ms
                  </div>
                )}
              {rerankPhase && (
                <div
                  style={{
                    borderTop: "1px solid var(--hair)",
                    marginTop: 4,
                    paddingTop: 4,
                  }}
                >
                  total{"   "}
                  {rerankPhase.ms.total}ms
                </div>
              )}
            </div>
          </>
        )}
      </aside>
    </div>
  );
}
