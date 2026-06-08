"use client";

/**
 * Dashboard view for /introspect/<handle>. Loads the snapshot on mount
 * (creating it via the fetch route if it doesn't exist yet), then surfaces:
 *   1. Deterministic engagement stats — a sticky left rail (UI-only, never
 *      sent to the LLM)
 *   2. The unified Aggregator profile — the hero of the page
 *   3. The process control + a live streaming progress rail
 *   4. Suggested feeds — built from the profile, the page's primary payoff
 *   5. Per-batch Extractor notes — collapsed rows (newest auto-expanded);
 *      each row opens a Details drawer with the deterministic breakdown
 *
 * "Process next batch" streams NDJSON from /api/introspect/process-batch:
 * phase events drive the rail, text deltas live-type the extractor note and
 * the profile. Every LLM action is user-triggered; no auto-polling.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import ReactMarkdown from "react-markdown";
import type {
  BatchInfo,
  BatchNote,
  CallTelemetry,
  Engagement,
  FeedSeedPrompts,
  SignalType,
  Snapshot,
  Subject,
} from "@/lib/introspect/types";

// ── Accent (teal) ──────────────────────────────────────────────────────
const ACCENT = "#0f766e";
const ACCENT_SOFT = "#e3f1ef";

// ── Cost / latency estimates for the inline Process-button preview ─────
const EST_EXTRACTOR_USD = 0.21;
const EST_AGGREGATOR_USD = 0.03;
const EST_PER_CLICK_S = 18;

const SIGNAL_ORDER: SignalType[] = ["like", "repost", "quote", "post", "reply"];
const SIGNAL_LABELS: Record<SignalType, string> = {
  like: "likes",
  repost: "reposts",
  quote: "quotes",
  post: "own posts",
  reply: "own replies",
};

// ── Streaming state ────────────────────────────────────────────────────
type StreamPhase = "extract" | "aggregate" | "seeds" | null;
interface StreamState {
  phase: StreamPhase;
  batchIndex: number | null;
  extractText: string;
  aggregateText: string;
}
const EMPTY_STREAM: StreamState = {
  phase: null,
  batchIndex: null,
  extractText: "",
  aggregateText: "",
};

type StreamEvent =
  | { t: "phase"; phase: Exclude<StreamPhase, null>; batchIndex?: number }
  | { t: "delta"; phase: "extract" | "aggregate"; text: string }
  | { t: "done"; snapshot: Snapshot }
  | { t: "error"; error: string; snapshot?: Snapshot; batchIndex?: number };

/**
 * Developer view toggle. Dev mode is the verbose debug view — cost, token
 * counts, model id, per-batch telemetry, and the internal "batch" framing.
 * Ordinary visitors get the clean, user-friendly view with none of that.
 *
 * The page is public (no sign-in) and cost numbers aren't sensitive, so the
 * gate is a simple client-side flag: append `?dev=1` to any introspect URL
 * to turn it on (persisted to localStorage so it sticks), `?dev=0` to turn
 * it off. Telemetry is still collected in the snapshot regardless — only the
 * rendering is gated.
 */
function useDevMode(): boolean {
  const [dev, setDev] = useState(false);
  useEffect(() => {
    try {
      const param = new URLSearchParams(window.location.search).get("dev");
      if (param === "1") localStorage.setItem("introspect:dev", "1");
      else if (param === "0") localStorage.removeItem("introspect:dev");
      setDev(localStorage.getItem("introspect:dev") === "1");
    } catch {
      // window/localStorage unavailable (SSR) — stay in user mode.
    }
  }, []);
  return dev;
}

export default function IntrospectDashboard({ handle }: { handle: string }) {
  const router = useRouter();
  const devMode = useDevMode();
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  // True from first render so we show the loading view (not the error/retry
  // view) before the auto-fetch effect kicks in.
  const [fetching, setFetching] = useState(true);
  const [processing, setProcessing] = useState(false);
  const [stream, setStream] = useState<StreamState>(EMPTY_STREAM);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);

  const callFetch = useCallback(
    async (force = false) => {
      setError(null);
      setInfo(null);
      setFetching(true);
      try {
        const res = await fetch("/api/introspect/fetch", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ handle, force }),
        });
        const data = await res.json();
        if (!res.ok) {
          setError(data.error || `fetch failed (${res.status})`);
          return;
        }
        setSnapshot(data.snapshot as Snapshot);
        if (data.unavailableCount > 0) {
          setInfo(
            `${data.unavailableCount} engaged-with posts were unavailable (deleted, blocked, or 404).`
          );
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : "fetch failed");
      } finally {
        setFetching(false);
      }
    },
    [handle]
  );

  // Auto-fetch on mount. The /fetch endpoint returns the cached snapshot
  // when present, so this is a no-op for revisits.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    callFetch(false);
  }, [callFetch]);

  const onProcess = useCallback(async () => {
    if (!snapshot) return;
    setError(null);
    setInfo(null);
    setProcessing(true);
    setStream(EMPTY_STREAM);

    const apply = (ev: StreamEvent) => {
      switch (ev.t) {
        case "phase":
          setStream((s) => ({
            ...s,
            phase: ev.phase,
            batchIndex: ev.batchIndex ?? s.batchIndex,
            // reset the buffer for the phase that's about to stream
            extractText: ev.phase === "extract" ? "" : s.extractText,
            aggregateText: ev.phase === "aggregate" ? "" : s.aggregateText,
          }));
          break;
        case "delta":
          setStream((s) =>
            ev.phase === "extract"
              ? { ...s, extractText: s.extractText + ev.text }
              : { ...s, aggregateText: s.aggregateText + ev.text }
          );
          break;
        case "done":
          setSnapshot(ev.snapshot);
          break;
        case "error":
          if (ev.snapshot) setSnapshot(ev.snapshot);
          setError(ev.error);
          break;
      }
    };

    try {
      const res = await fetch("/api/introspect/process-batch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ handle: snapshot.handle }),
      });
      if (!res.ok || !res.body) {
        const data = await res.json().catch(() => ({}));
        if (data.snapshot) setSnapshot(data.snapshot as Snapshot);
        setError(data.error || `process failed (${res.status})`);
        return;
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let nl: number;
        while ((nl = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (line) apply(JSON.parse(line) as StreamEvent);
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "process failed");
    } finally {
      setProcessing(false);
      setStream(EMPTY_STREAM);
    }
  }, [snapshot]);

  const onReset = useCallback(async () => {
    if (!snapshot) return;
    if (
      !confirm(
        `Delete all stored data for @${snapshot.handle}? This will wipe the analysis and profile. Cached images stay.`
      )
    ) {
      return;
    }
    try {
      await fetch("/api/introspect/reset", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ handle: snapshot.handle }),
      });
      router.push("/introspect");
    } catch (err) {
      setError(err instanceof Error ? err.message : "reset failed");
    }
  }, [snapshot, router]);

  if (fetching && !snapshot) {
    return (
      <main className="min-h-screen bg-[#fafafa] text-[#1a1a1a]">
        <div className="mx-auto max-w-2xl px-6 py-24">
          <h1 className="text-3xl font-serif mb-3">introspect</h1>
          <p className="font-mono text-sm text-[#444] mb-2">@{handle}</p>
          <p className="text-[#666]">
            Resolving handle → PDS → listing records → hydrating posts. Takes
            ~10–20s on first run.
          </p>
        </div>
      </main>
    );
  }

  if (!snapshot) {
    return (
      <main className="min-h-screen bg-[#fafafa] text-[#1a1a1a]">
        <div className="mx-auto max-w-2xl px-6 py-24">
          <h1 className="text-3xl font-serif mb-3">introspect</h1>
          <p className="font-mono text-sm text-[#444] mb-4">@{handle}</p>
          {error && (
            <p className="text-sm text-red-700 bg-red-50 border-l-2 border-red-700 px-3 py-2 mb-4">
              {error}
            </p>
          )}
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => callFetch(false)}
              className="px-4 py-2 bg-[#1a1a1a] text-white rounded"
            >
              Retry
            </button>
            <button
              type="button"
              onClick={() => router.push("/introspect")}
              className="px-4 py-2 border border-[#ddd] rounded"
            >
              Try a different handle
            </button>
          </div>
        </div>
      </main>
    );
  }

  return (
    <IntrospectLoaded
      snapshot={snapshot}
      devMode={devMode}
      processing={processing}
      fetching={fetching}
      stream={stream}
      info={info}
      error={error}
      onProcess={onProcess}
      onReset={onReset}
      onRefresh={() => callFetch(true)}
    />
  );
}

// ── Loaded state ───────────────────────────────────────────────────────

function IntrospectLoaded({
  snapshot,
  devMode,
  processing,
  fetching,
  stream,
  info,
  error,
  onProcess,
  onReset,
  onRefresh,
}: {
  snapshot: Snapshot;
  devMode: boolean;
  processing: boolean;
  fetching: boolean;
  stream: StreamState;
  info: string | null;
  error: string | null;
  onProcess: () => void;
  onReset: () => void;
  onRefresh: () => void;
}) {
  const { batches, batchNotes, profile } = snapshot;
  const [drawerBatch, setDrawerBatch] = useState<number | null>(null);

  const processedCount = Object.keys(batchNotes).length;
  const totalBatches = batches.length;
  // User-facing progress is framed in engagements analyzed, not "batches".
  const analyzedCount = batches
    .filter((b) => batchNotes[b.index])
    .reduce((sum, b) => sum + b.engagementIds.length, 0);
  const totalEngagements = snapshot.engagements.length;

  return (
    <main className="min-h-screen bg-[#fafafa] text-[#1a1a1a]">
      <div className="mx-auto max-w-[1120px] px-4 py-6 pb-20 sm:px-6 sm:py-8 sm:pb-24">
        <header className="border-b border-[#1a1a1a] pb-4 mb-6 sm:mb-7 flex justify-between items-baseline gap-3 flex-wrap">
          <h1 className="text-2xl sm:text-[28px] font-serif tracking-tight">
            introspect{" "}
            <span className="font-mono text-[13px] sm:text-sm text-[#666] font-normal ml-1 break-all">
              @{snapshot.handle}
            </span>
            <span className="text-[#888] text-xs ml-2 sm:ml-3 font-normal">
              refreshed {relativeTime(snapshot.fetchedAt)}
            </span>
          </h1>
          <div className="flex gap-2 text-sm">
            <button
              type="button"
              onClick={onRefresh}
              disabled={fetching || processing}
              className="px-3 py-1.5 border border-[#1a1a1a] rounded hover:bg-[#1a1a1a] hover:text-white disabled:opacity-50"
            >
              {fetching ? "Refreshing…" : "Refresh"}
            </button>
            <button
              type="button"
              onClick={onReset}
              disabled={fetching || processing}
              className="px-3 py-1.5 border border-[#ddd] text-[#666] rounded hover:border-red-700 hover:text-red-700 disabled:opacity-50"
            >
              Reset
            </button>
          </div>
        </header>

        {(info || error) && (
          <div className="mb-6 space-y-2">
            {info && (
              <p className="text-sm text-[#444] bg-amber-50 border-l-2 border-amber-500 px-3 py-2">
                {info}
              </p>
            )}
            {error && (
              <p className="text-sm text-red-700 bg-red-50 border-l-2 border-red-700 px-3 py-2">
                {error}
              </p>
            )}
          </div>
        )}

        <div className="grid grid-cols-1 md:grid-cols-[280px_1fr] gap-6 md:gap-8 items-start">
          {/* ── Left rail: deterministic stats ─────────────── */}
          {/* On mobile this drops below the main column (stats are secondary
              to the profile + action), then returns to the sticky left rail
              at md. */}
          <div className="order-2 md:order-1 md:sticky md:top-6 flex flex-col gap-4">
            <StatsRail snapshot={snapshot} />
          </div>

          {/* ── Main column ────────────────────────────────── */}
          <div className="order-1 md:order-2 flex flex-col gap-6 min-w-0">
            {!profile && !stream.phase && (
              <p className="text-[#666] italic text-sm">
                Analyze your activity to build your profile and suggested feeds.
              </p>
            )}

            {/* Suggested feeds. While the seeds phase is running we show a
                loader in their place (on the first run there are no prompts
                yet; on later runs the stale ones are hidden until refreshed). */}
            {stream.phase === "seeds" ? (
              <SuggestingFeedsLoader />
            ) : (
              snapshot.feedSeedPrompts &&
              snapshot.feedSeedPrompts.prompts.length > 0 && (
                <SuggestedFeeds seeds={snapshot.feedSeedPrompts} devMode={devMode} />
              )
            )}

            {/* Profile hero stays up once there's a profile or any has been
                streamed this run — including through the seeds phase, where
                the freshly-streamed text lives in stream.aggregateText until
                the final snapshot lands. */}
            {(profile || stream.aggregateText.length > 0) && (
              <ProfileHero
                snapshot={snapshot}
                devMode={devMode}
                stream={stream}
                processedCount={processedCount}
                totalBatches={totalBatches}
                analyzedCount={analyzedCount}
                totalEngagements={totalEngagements}
              />
            )}

            {totalBatches > 0 && (
              <ProcessStrip
                snapshot={snapshot}
                devMode={devMode}
                processing={processing}
                fetching={fetching}
                stream={stream}
                onProcess={onProcess}
                analyzedCount={analyzedCount}
                totalEngagements={totalEngagements}
              />
            )}

            {totalBatches > 0 && (
              <BatchNotes
                batches={batches}
                batchNotes={batchNotes}
                devMode={devMode}
                stream={stream}
                analyzedCount={analyzedCount}
                totalEngagements={totalEngagements}
                onOpenDetails={setDrawerBatch}
              />
            )}
          </div>
        </div>
      </div>

      {drawerBatch !== null && (
        <DetailDrawer
          batch={batches.find((b) => b.index === drawerBatch)!}
          note={batchNotes[drawerBatch]}
          devMode={devMode}
          engagements={snapshot.engagements}
          onClose={() => setDrawerBatch(null)}
        />
      )}
    </main>
  );
}

// ── Stats rail ─────────────────────────────────────────────────────────

function StatsRail({ snapshot }: { snapshot: Snapshot }) {
  const { stats } = snapshot;
  if (stats.total === 0) {
    return (
      <div className="p-4 bg-amber-50 border-l-2 border-amber-500 text-sm rounded">
        No engagements found for this handle yet — come back after more
        activity.
      </div>
    );
  }
  const maxPct = Math.max(...SIGNAL_ORDER.map((s) => stats.byType[s].pct));
  return (
    <>
      <Panel title="Engagement">
        <KV label="total" value={stats.total.toLocaleString()} />
        <KV label="span" value={`${stats.spanDays} d`} />
        <KV label="avg / day" value={String(stats.avgPerDay)} />
        {stats.recent30d.pctChange !== null && (
          <KV
            label="last 30 d"
            value={`${stats.recent30d.pctChange >= 0 ? "↑" : "↓"} ${Math.abs(
              stats.recent30d.pctChange
            )}%`}
            valueClass={
              stats.recent30d.pctChange >= 0
                ? "text-[#0f766e]"
                : "text-amber-700"
            }
          />
        )}
        <div className="flex flex-col gap-1.5 mt-3">
          {SIGNAL_ORDER.map((t) => {
            const row = stats.byType[t];
            if (row.count === 0) return null;
            return (
              <div
                key={t}
                className="grid grid-cols-[58px_1fr_auto] gap-2 items-center text-xs"
              >
                <span className="text-[#444]">{SIGNAL_LABELS[t]}</span>
                <div className="h-3.5 bg-[#f0f0f0] rounded-sm overflow-hidden relative">
                  <div
                    className="absolute inset-y-0 left-0"
                    style={{
                      width: `${maxPct > 0 ? (row.pct / maxPct) * 100 : 0}%`,
                      background: ACCENT,
                    }}
                  />
                </div>
                <span className="font-mono text-[10px] text-[#888]">
                  {row.pct}%
                </span>
              </div>
            );
          })}
        </div>
      </Panel>

      <Panel title="Ratios">
        <KV
          label="repost : like"
          value={fmtRatio(stats.ratios.repostToLike)}
          title={ratioHint("repostToLike", stats.ratios.repostToLike)}
        />
        <KV
          label="quote : repost"
          value={fmtRatio(stats.ratios.quoteToRepost)}
          title={ratioHint("quoteToRepost", stats.ratios.quoteToRepost)}
        />
        <KV
          label="own : consumed"
          value={fmtRatio(stats.ratios.ownToConsumed)}
          title={ratioHint("ownToConsumed", stats.ratios.ownToConsumed)}
        />
      </Panel>

      {stats.topAccounts.length > 0 && (
        <Panel title="Top accounts">
          {stats.topAccounts.map((a) => (
            <div
              key={a.handle}
              className="flex justify-between text-xs py-1"
              title={(["like", "repost", "quote", "reply"] as SignalType[])
                .map((t) => {
                  const n = a.byType[t] ?? 0;
                  return n ? `${n} ${SIGNAL_LABELS[t]}` : null;
                })
                .filter(Boolean)
                .join(" · ")}
            >
              <span className="font-mono text-[#1a1a1a]">{a.handle}</span>
              <span className="font-mono text-[10px] text-[#888]">
                {a.total} total
              </span>
            </div>
          ))}
        </Panel>
      )}
    </>
  );
}

function Panel({
  title,
  tag,
  children,
}: {
  title: string;
  tag?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="bg-white border border-[#e8e8e8] rounded-[10px] p-[18px]">
      <h3 className="font-serif text-[15px] mb-3 flex items-center gap-2">
        {title}
        {tag && (
          <span className="font-mono text-[9px] uppercase tracking-wide text-[#888] bg-[#f4f4f4] px-1.5 py-0.5 rounded">
            {tag}
          </span>
        )}
      </h3>
      {children}
    </div>
  );
}

function KV({
  label,
  value,
  valueClass = "",
  title,
}: {
  label: string;
  value: string;
  valueClass?: string;
  title?: string;
}) {
  return (
    <div
      className="flex justify-between text-[13px] py-1.5 border-b border-[#eee] last:border-0"
      title={title}
    >
      <span>{label}</span>
      <span className={`font-mono ${valueClass}`}>{value}</span>
    </div>
  );
}

// ── Profile hero ───────────────────────────────────────────────────────

function ProfileHero({
  snapshot,
  devMode,
  stream,
  processedCount,
  totalBatches,
  analyzedCount,
  totalEngagements,
}: {
  snapshot: Snapshot;
  devMode: boolean;
  stream: StreamState;
  processedCount: number;
  totalBatches: number;
  analyzedCount: number;
  totalEngagements: number;
}) {
  const { profile } = snapshot;
  const aggregating = stream.phase === "aggregate";
  // Prefer text streamed this run (it persists in aggregateText through the
  // seeds phase, after aggregation finishes) over the committed profile.
  const liveText = stream.aggregateText || profile?.text || "";

  return (
    <div
      className="bg-white rounded-xl p-5 sm:p-7"
      style={{
        border: `1px solid ${ACCENT}`,
        boxShadow: `0 1px 0 ${ACCENT_SOFT}, 0 8px 24px -18px ${ACCENT}`,
      }}
    >
      <div
        className="font-mono text-[10px] tracking-[1.5px] uppercase mb-2.5 flex items-center gap-2"
        style={{ color: ACCENT }}
      >
        <span className="inline-block w-[18px] h-0.5" style={{ background: ACCENT }} />
        Unified profile
      </div>

      {liveText ? (
        <div className="text-[15px]">
          <MarkdownBody text={liveText} hero />
          {aggregating && <Cursor />}
        </div>
      ) : (
        <p className="text-[#888] italic">
          Analyze your activity to build your profile.
        </p>
      )}

      {profile && !aggregating && (
        <div className="font-mono text-[10px] text-[#bbb] mt-4 pt-3.5 border-t border-[#eee]">
          {analyzedCount < totalEngagements && (
            <span className="text-amber-700 mr-2">
              partial — analyze more to deepen this
            </span>
          )}
          Built from {analyzedCount.toLocaleString()} of{" "}
          {totalEngagements.toLocaleString()} engagements
          {devMode && (
            <>
              {" "}· {processedCount}/{totalBatches} batches ·{" "}
              <span
                className="cursor-help border-b border-dotted border-[#ccc]"
                title={telemetryTitle(profile.telemetry)}
              >
                aggregator ⓘ
              </span>
            </>
          )}
        </div>
      )}
    </div>
  );
}

// ── Process strip + streaming rail ─────────────────────────────────────

function ProcessStrip({
  snapshot,
  devMode,
  processing,
  fetching,
  stream,
  onProcess,
  analyzedCount,
  totalEngagements,
}: {
  snapshot: Snapshot;
  devMode: boolean;
  processing: boolean;
  fetching: boolean;
  stream: StreamState;
  onProcess: () => void;
  analyzedCount: number;
  totalEngagements: number;
}) {
  const { batches, batchNotes, profile, callHistory } = snapshot;
  const processedCount = Object.keys(batchNotes).length;
  const totalBatches = batches.length;
  const remaining = totalBatches - processedCount;
  const allDone = remaining === 0;
  const perClickCost = EST_EXTRACTOR_USD + EST_AGGREGATOR_USD;

  const sessionSpend = useMemo(
    () => callHistory.reduce((sum, t) => sum + t.costUsd, 0),
    [callHistory]
  );
  const estimateToFinish = remaining * perClickCost;

  // Dev mode appends the cost/latency estimate to the button; users see a
  // plain action label with no pricing.
  const devSuffix =
    !devMode || allDone
      ? ""
      : ` · ~$${perClickCost.toFixed(2)} · ~${EST_PER_CLICK_S}s`;
  const label = processing
    ? stream.phase === "extract"
      ? "Analyzing your activity…"
      : stream.phase === "aggregate"
        ? "Building your profile…"
        : stream.phase === "seeds"
          ? "Suggesting feeds…"
          : "Analyzing…"
    : allDone && profile !== null
      ? "All activity analyzed"
      : allDone && profile === null
        ? `Retry profile${devMode ? ` (~$${EST_AGGREGATOR_USD.toFixed(2)}, ~5s)` : ""}`
        : `${processedCount === 0 ? "Analyze your activity" : "Analyze more activity"}${devSuffix}`;

  return (
    <div className="bg-white border border-[#e0e0e0] rounded-xl p-4 sm:p-5">
      <div className="flex justify-between text-[13px] text-[#666] mb-1 flex-wrap gap-2">
        <span>
          {processing ? (
            <>Analyzing…</>
          ) : allDone ? (
            <>
              All{" "}
              <strong className="text-[#1a1a1a]">
                {totalEngagements.toLocaleString()}
              </strong>{" "}
              engagements analyzed
            </>
          ) : (
            <>
              <strong className="text-[#1a1a1a]">
                {analyzedCount.toLocaleString()}
              </strong>{" "}
              of {totalEngagements.toLocaleString()} engagements analyzed
            </>
          )}
        </span>
        {devMode && (
          <span>
            session{" "}
            <strong className="text-[#1a1a1a] font-mono">
              ${sessionSpend.toFixed(2)}
            </strong>
            {!allDone && (
              <>
                {" "}· est. to finish{" "}
                <strong className="text-[#1a1a1a] font-mono">
                  ~${estimateToFinish.toFixed(2)}
                </strong>
              </>
            )}
          </span>
        )}
      </div>

      {processing && <StreamRail stream={stream} />}

      <button
        type="button"
        onClick={onProcess}
        disabled={processing || fetching || (allDone && profile !== null)}
        className="w-full py-3 rounded-[10px] text-[15px] font-semibold text-white disabled:opacity-55 disabled:cursor-default mt-2"
        style={{ background: ACCENT }}
      >
        {label}
      </button>
    </div>
  );
}

function StreamRail({ stream }: { stream: StreamState }) {
  // step order: extract → aggregate → seeds. A step is "done" once a later
  // phase is active; "active" while it is the current phase.
  const order: Array<Exclude<StreamPhase, null>> = [
    "extract",
    "aggregate",
    "seeds",
  ];
  const current = stream.phase ? order.indexOf(stream.phase) : -1;
  const labels = {
    extract: "Read activity",
    aggregate: "Build profile",
    seeds: "Suggest feeds",
  };

  return (
    <div className="flex items-center my-3.5">
      {order.map((p, i) => {
        const done = current > i;
        const active = current === i;
        return (
          <div key={p} className="flex items-center flex-1 last:flex-none">
            <div
              className="flex items-center gap-2 text-xs whitespace-nowrap"
              style={{
                color: active ? ACCENT : done ? "#444" : "#888",
                fontWeight: active ? 600 : 400,
              }}
            >
              <span
                className="w-[18px] h-[18px] rounded-full border-2 flex items-center justify-center text-[10px]"
                style={{
                  background: done ? ACCENT : "#fff",
                  borderColor: done || active ? ACCENT : "#e0e0e0",
                  color: done ? "#fff" : ACCENT,
                }}
              >
                {done ? "✓" : active ? <Spinner /> : ""}
              </span>
              {labels[p]}
            </div>
            {i < order.length - 1 && (
              <div
                className="flex-1 h-0.5 mx-2.5 min-w-5"
                style={{ background: done ? ACCENT : "#e0e0e0" }}
              />
            )}
          </div>
        );
      })}
    </div>
  );
}

function Spinner() {
  return (
    <span
      className="inline-block w-2 h-2 rounded-full border-2 animate-spin"
      style={{ borderColor: ACCENT, borderTopColor: "transparent" }}
    />
  );
}

function Cursor() {
  return (
    <span
      className="inline-block w-[7px] h-4 ml-0.5 align-[-2px] animate-pulse"
      style={{ background: ACCENT }}
    />
  );
}

// ── Suggested feeds (callout) ──────────────────────────────────────────

/** Placeholder shown while the feed-seed generator is running. */
function SuggestingFeedsLoader() {
  return (
    <section>
      <h3 className="font-serif text-lg">Suggested feeds</h3>
      <div
        className="rounded-[14px] p-4 sm:p-[22px] mt-4 flex items-center gap-3 text-sm"
        style={{
          background: ACCENT_SOFT,
          border: `1px solid ${ACCENT}`,
          color: ACCENT,
        }}
      >
        <Spinner />
        Suggesting feeds…
      </div>
    </section>
  );
}

function SuggestedFeeds({
  seeds,
  devMode,
}: {
  seeds: FeedSeedPrompts;
  devMode: boolean;
}) {
  const router = useRouter();
  return (
    <section>
      <div className="flex items-baseline justify-between gap-2 flex-wrap">
        <h3 className="font-serif text-lg">Suggested feeds</h3>
      </div>
      <p className="text-xs text-[#888] mt-1.5 mb-4">
        Built from your profile. Click one to open the curator with the prompt
        pre-filled.{" "}
        {devMode && (
          <span className="font-mono text-[#888]">
            · generator: ${seeds.telemetry.costUsd.toFixed(3)}
          </span>
        )}
      </p>
      <div
        className="rounded-[14px] p-4 sm:p-[22px]"
        style={{ background: ACCENT_SOFT, border: `1px solid ${ACCENT}` }}
      >
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          {seeds.prompts.map((prompt, i) => (
            <button
              key={i}
              type="button"
              onClick={() =>
                router.push(`/curator?new=1&prompt=${encodeURIComponent(prompt)}`)
              }
              className="text-left bg-white border border-white rounded-[10px] p-4 hover:-translate-y-px transition-all"
              style={{ boxShadow: "0 1px 2px rgba(0,0,0,0.04)" }}
            >
              <p className="text-[15px] leading-relaxed text-[#1a1a1a]">
                {prompt}
              </p>
              <p
                className="font-mono text-[11px] mt-2.5"
                style={{ color: ACCENT }}
              >
                Open curator →
              </p>
            </button>
          ))}
        </div>
      </div>
    </section>
  );
}

// ── Batch notes ────────────────────────────────────────────────────────

function BatchNotes({
  batches,
  batchNotes,
  devMode,
  stream,
  analyzedCount,
  totalEngagements,
  onOpenDetails,
}: {
  batches: BatchInfo[];
  batchNotes: Record<number, BatchNote>;
  devMode: boolean;
  stream: StreamState;
  analyzedCount: number;
  totalEngagements: number;
  onOpenDetails: (index: number) => void;
}) {
  // Newest batch with a note auto-expands; everything else collapsed.
  const newestProcessed = batches.find((b) => batchNotes[b.index])?.index ?? null;
  const [open, setOpen] = useState<Record<number, boolean>>(
    newestProcessed !== null ? { [newestProcessed]: true } : {}
  );
  const toggle = (i: number) => setOpen((o) => ({ ...o, [i]: !o[i] }));

  return (
    <section>
      <h3 className="font-serif text-[17px] border-b border-[#e0e0e0] pb-2 mb-1">
        {devMode ? "Batch notes" : "What we found"}
      </h3>
      <p className="text-xs text-[#888] my-2">
        Newest activity first.{" "}
        {devMode && (
          <strong className="text-[#1a1a1a]">
            Each batch = 100 engagement records.{" "}
          </strong>
        )}
        {analyzedCount.toLocaleString()} of {totalEngagements.toLocaleString()}{" "}
        engagements analyzed. Click a row to read the notes, or{" "}
        <strong className="text-[#1a1a1a]">Details</strong> for the breakdown.
      </p>
      <div>
        {batches.map((b) => {
          const note = batchNotes[b.index];
          // The text streamed for this batch this run. It stays in
          // stream.extractText through the aggregate + seeds phases (until the
          // final snapshot commits the note), so keep rendering it the whole
          // time — otherwise the just-analyzed activity blanks out while the
          // profile is being generated.
          const isThisRow = stream.batchIndex === b.index;
          const streamText = isThisRow && !note ? stream.extractText : "";
          return (
            <BatchRow
              key={b.index}
              batch={b}
              note={note}
              devMode={devMode}
              isStreaming={stream.phase === "extract" && isThisRow}
              streamText={streamText}
              open={!!open[b.index]}
              onToggle={() => toggle(b.index)}
              onOpenDetails={() => onOpenDetails(b.index)}
            />
          );
        })}
      </div>
    </section>
  );
}

function BatchRow({
  batch,
  note,
  devMode,
  isStreaming,
  streamText,
  open,
  onToggle,
  onOpenDetails,
}: {
  batch: BatchInfo;
  note: BatchNote | undefined;
  devMode: boolean;
  isStreaming: boolean;
  streamText: string;
  open: boolean;
  onToggle: () => void;
  onOpenDetails: () => void;
}) {
  // Render streamed text whenever we have it for this row (through every
  // phase), not only while it's actively typing.
  const live = streamText ? splitHeadline(streamText) : null;
  const headline =
    live?.headline ||
    note?.headline ||
    (isStreaming ? "Analyzing…" : note ? firstSentence(note.text) : "Not yet analyzed");
  const expanded = open || !!streamText || isStreaming;

  return (
    <div className="border-b border-[#eee]">
      {/* Wraps on mobile: headline (+ Details) on the first line, the
          count·date meta drops to its own line below; single row at sm+. */}
      <div className="flex flex-wrap gap-x-3 gap-y-1 items-center py-3 sm:py-3.5 px-1 hover:bg-[#fcfcfc]">
        <button
          type="button"
          onClick={onToggle}
          className="order-1 flex gap-3 items-center flex-1 min-w-0 text-left"
        >
          <span
            className="text-[11px] transition-transform"
            style={{
              color: "#888",
              transform: expanded ? "rotate(90deg)" : "none",
            }}
          >
            ▸
          </span>
          {devMode && (
            <span
              className="font-mono text-[11px] font-semibold flex-none"
              style={{ color: ACCENT }}
            >
              Batch {batch.index}
            </span>
          )}
          <span className="text-sm text-[#1a1a1a] flex-1 truncate">
            {headline}
          </span>
        </button>
        <span className="order-3 sm:order-2 basis-full sm:basis-auto sm:flex-none font-mono text-[11px] text-[#888] pl-[26px] sm:pl-0">
          {batch.engagementIds.length} engagements · {fmtDate(batch.startTs)} →{" "}
          {fmtDate(batch.endTs)}
        </span>
        {note && (
          <button
            type="button"
            onClick={onOpenDetails}
            className="order-2 sm:order-3 font-mono text-[10px] text-[#666] bg-[#f4f4f4] border border-[#eee] px-2.5 py-1 rounded-md hover:border-[#0f766e] hover:text-[#0f766e] flex-none"
          >
            Details
          </button>
        )}
      </div>

      {expanded && (
        <div className="pt-0.5 pb-5 pl-[30px] pr-1">
          {streamText ? (
            <div className="text-[15px]">
              <MarkdownBody text={live?.body ?? ""} />
              {isStreaming && <Cursor />}
            </div>
          ) : note ? (
            <MarkdownBody text={note.text} />
          ) : (
            <p className="text-[#999] italic text-sm">
              Not yet analyzed. Click <em>Analyze more activity</em> above.
            </p>
          )}
        </div>
      )}
    </div>
  );
}

// ── Detail drawer (right sidebar) ──────────────────────────────────────

function DetailDrawer({
  batch,
  note,
  devMode,
  engagements,
  onClose,
}: {
  batch: BatchInfo;
  note: BatchNote | undefined;
  devMode: boolean;
  engagements: Engagement[];
  onClose: () => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const detail = useMemo(
    () => deriveBatchDetail(batch, engagements),
    [batch, engagements]
  );
  const maxMix = Math.max(...SIGNAL_ORDER.map((t) => batch.mix[t]), 1);

  return (
    <>
      <div
        className="fixed inset-0 bg-[#1a1a1a]/30 z-[70]"
        onClick={onClose}
        aria-hidden
      />
      <aside className="fixed top-0 right-0 h-screen w-[380px] max-w-[90vw] bg-white shadow-2xl z-[80] flex flex-col">
        <div className="flex justify-between items-baseline px-6 pt-5 pb-4 border-b border-[#e0e0e0]">
          <div>
            <div className="font-serif text-xl">
              {devMode
                ? `Batch ${batch.index}`
                : `${fmtDate(batch.startTs)} → ${fmtDate(batch.endTs)}`}
            </div>
            <div className="font-mono text-[11px] text-[#888] mt-1">
              {batch.engagementIds.length} engagements
              {devMode && (
                <>
                  {" "}· {fmtDate(batch.startTs)} → {fmtDate(batch.endTs)}
                </>
              )}{" "}
              · spans {detail.spanDays}d
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="text-[22px] text-[#666] leading-none hover:text-[#1a1a1a]"
          >
            ×
          </button>
        </div>

        <div className="px-6 py-5 overflow-y-auto">
          <DrawerSection title="Signal mix">
            {SIGNAL_ORDER.map((t) => {
              const n = batch.mix[t];
              if (n === 0) return null;
              return (
                <div
                  key={t}
                  className="grid grid-cols-[80px_1fr_32px] gap-2.5 items-center text-[13px] mb-1.5"
                >
                  <span className="text-[#333] capitalize">
                    {SIGNAL_LABELS[t]}
                  </span>
                  <div className="h-3.5 bg-[#f0f0f0] rounded-sm overflow-hidden relative">
                    <div
                      className="absolute inset-y-0 left-0"
                      style={{ width: `${(n / maxMix) * 100}%`, background: ACCENT }}
                    />
                  </div>
                  <span className="font-mono text-xs text-right text-[#333]">
                    {n}
                  </span>
                </div>
              );
            })}
          </DrawerSection>

          {detail.topAccounts.length > 0 && (
            <DrawerSection title="Top accounts in this batch">
              {detail.topAccounts.map((a) => (
                <div
                  key={a.handle}
                  className="flex justify-between text-[13px] py-1.5 border-b border-[#eee] last:border-0"
                >
                  <span className="font-mono text-[#1a1a1a]">{a.handle}</span>
                  <span className="font-mono text-[11px] text-[#888]">
                    {a.count} engagements
                  </span>
                </div>
              ))}
            </DrawerSection>
          )}

          <DrawerSection title="Media">
            <div className="grid grid-cols-2 gap-2.5">
              <Factbox n={`${detail.imagePct}%`} l="with images" />
              <Factbox n={`${detail.linkPct}%`} l="with link cards" />
            </div>
          </DrawerSection>

          {note && devMode && (
            <DrawerSection title="Extractor run">
              <div className="font-mono text-[11px] text-[#666] leading-relaxed">
                cost ${note.telemetry.costUsd.toFixed(3)} ·{" "}
                {(note.telemetry.latencyMs / 1000).toFixed(1)}s
                <br />
                {note.telemetry.inputTokens.toLocaleString()} →{" "}
                {note.telemetry.outputTokens.toLocaleString()} tokens
                <br />
                {note.imagesAttached} images attached
                {note.imagesFailed > 0 && (
                  <span className="text-amber-700">
                    {" "}· {note.imagesFailed} failed
                  </span>
                )}
                <br />
                {note.telemetry.modelId}
              </div>
            </DrawerSection>
          )}
        </div>
      </aside>
    </>
  );
}

function DrawerSection({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="mb-6">
      <h5 className="font-mono text-[10px] tracking-wide uppercase text-[#888] mb-2.5">
        {title}
      </h5>
      {children}
    </section>
  );
}

function Factbox({ n, l }: { n: string; l: string }) {
  return (
    <div className="bg-[#fafafa] border border-[#eee] rounded-lg px-3 py-2.5">
      <div className="font-serif text-lg">{n}</div>
      <div className="text-[10px] uppercase tracking-wide text-[#888] mt-0.5">
        {l}
      </div>
    </div>
  );
}

/** Deterministic per-batch breakdown for the drawer (no LLM). */
function deriveBatchDetail(batch: BatchInfo, engagements: Engagement[]) {
  const inBatch = engagements.filter((e) => batch.engagementIds.includes(e.id));
  const counts = new Map<string, number>();
  let withImages = 0;
  let withLinks = 0;
  for (const e of inBatch) {
    const author = e.subject.author;
    if (author) counts.set(author, (counts.get(author) ?? 0) + 1);
    if (hasImages(e.subject)) withImages++;
    if (e.subject.linkCard) withLinks++;
  }
  const topAccounts = [...counts.entries()]
    .map(([handle, count]) => ({ handle, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 5);
  const n = inBatch.length || 1;
  const spanMs = Date.parse(batch.endTs) - Date.parse(batch.startTs);
  return {
    topAccounts,
    imagePct: Math.round((withImages / n) * 100),
    linkPct: Math.round((withLinks / n) * 100),
    spanDays: Number.isFinite(spanMs)
      ? Math.max(1, Math.round(spanMs / 86_400_000))
      : 0,
  };
}

function hasImages(s: Subject | null | undefined): boolean {
  if (!s) return false;
  if (s.imageCids && s.imageCids.length > 0) return true;
  return hasImages(s.quoting) || hasImages(s.replyingTo);
}

// ── Markdown renderer ──────────────────────────────────────────────────

/**
 * Renders the model's prose output. Both Extractor and Aggregator return
 * markdown — headers, bold, italics, lists. Tailwind classes restyle each
 * element. `hero` bumps the body size for the profile card.
 */
function MarkdownBody({ text, hero = false }: { text: string; hero?: boolean }) {
  return (
    <div
      className={`prose-introspect ${
        hero ? "text-base" : "text-[14px]"
      } leading-relaxed text-[#1a1a1a]`}
    >
      <ReactMarkdown
        components={{
          h1: (props) => (
            <h1
              className="text-2xl font-serif mt-2 mb-3 border-b border-[#ddd] pb-1"
              {...props}
            />
          ),
          h2: (props) => (
            <h2 className="text-xl font-serif mt-5 mb-2" {...props} />
          ),
          h3: (props) => (
            <h3
              className="text-base font-semibold mt-4 mb-1.5 text-[#1a1a1a]"
              {...props}
            />
          ),
          h4: (props) => (
            <h4
              className="text-sm font-semibold mt-3 mb-1 text-[#1a1a1a]"
              {...props}
            />
          ),
          p: (props) => <p className="my-2.5" {...props} />,
          ul: (props) => (
            <ul className="list-disc pl-5 my-2.5 space-y-1" {...props} />
          ),
          ol: (props) => (
            <ol className="list-decimal pl-5 my-2.5 space-y-1" {...props} />
          ),
          li: (props) => <li className="leading-relaxed" {...props} />,
          strong: (props) => (
            <strong className="font-semibold text-[#1a1a1a]" {...props} />
          ),
          em: (props) => <em className="italic text-[#0a5249]" {...props} />,
          code: (props) => (
            <code
              className="bg-[#f4f4f4] text-[#333] px-1.5 py-0.5 rounded text-[0.9em] font-mono"
              {...props}
            />
          ),
          blockquote: (props) => (
            <blockquote
              className="border-l-2 border-[#ddd] pl-3 italic text-[#555] my-3"
              {...props}
            />
          ),
          hr: () => <hr className="my-4 border-[#eee]" />,
          a: (props) => (
            <a
              className="text-[#0a5249] underline decoration-[#bbb] hover:decoration-[#0a5249]"
              target="_blank"
              rel="noreferrer"
              {...props}
            />
          ),
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}

// ── Small utilities ────────────────────────────────────────────────────

/** Client-side mirror of the server's HEADLINE: parser, for live streaming. */
function splitHeadline(raw: string): { headline: string; body: string } {
  const m = raw.match(/^\s*HEADLINE:\s*([^\n]*)\n?([\s\S]*)$/i);
  if (!m) return { headline: "", body: raw };
  return { headline: m[1].replace(/\.$/, "").trim(), body: (m[2] ?? "").trim() };
}

function firstSentence(text: string): string {
  const clean = text.replace(/[#*_`>]/g, "").trim();
  const m = clean.match(/^.{0,90}?[.!?](\s|$)/);
  return (m ? m[0] : clean.slice(0, 90)).trim() || "Processed";
}

function fmtRatio(v: number | null): string {
  return v === null ? "—" : v.toFixed(2);
}

function telemetryTitle(t: CallTelemetry): string {
  return `$${t.costUsd.toFixed(3)} · ${(t.latencyMs / 1000).toFixed(
    1
  )}s · ${t.inputTokens.toLocaleString()}→${t.outputTokens.toLocaleString()} tok · ${
    t.modelId
  }`;
}

function ratioHint(
  kind: "repostToLike" | "quoteToRepost" | "ownToConsumed",
  v: number | null
): string {
  if (v === null) return "insufficient data";
  if (kind === "repostToLike") {
    if (v < 0.1) return "reposts look very selective";
    if (v < 0.25) return "selective amplification";
    return "reposts ≈ louder likes";
  }
  if (kind === "quoteToRepost") {
    if (v < 0.15) return "rarely adds commentary";
    if (v < 0.35) return "commentary on ~1-in-3 reposts";
    return "commentary-heavy";
  }
  if (kind === "ownToConsumed") {
    if (v < 0.2) return "consumer-leaning";
    if (v < 0.6) return "balanced";
    return "producer-leaning";
  }
  return "";
}

function fmtDate(iso: string): string {
  if (!iso) return "—";
  return iso.slice(0, 10);
}

function relativeTime(iso: string): string {
  const ms = Date.now() - Date.parse(iso);
  if (!Number.isFinite(ms)) return "—";
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} hr ago`;
  const d = Math.floor(h / 24);
  return `${d} day${d === 1 ? "" : "s"} ago`;
}
