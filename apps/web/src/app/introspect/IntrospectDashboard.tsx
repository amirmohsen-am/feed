"use client";

/**
 * Dashboard view for /introspect/<handle>. Loads the snapshot on mount
 * (creating it via the fetch route if it doesn't exist yet), then surfaces:
 *   1. Deterministic engagement stats (UI-only, never sent to the LLM)
 *   2. Per-batch Extractor notes — one card each, rendered as markdown
 *   3. Unified Aggregator profile, regenerated after every "Process next batch"
 *
 * Every LLM action is user-triggered. No auto-polling.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import ReactMarkdown from "react-markdown";
import type {
  BatchInfo,
  BatchNote,
  CallTelemetry,
  FeedSeedPrompts,
  SignalType,
  Snapshot,
} from "@/lib/introspect/types";
import IntrospectBackLink from "./IntrospectBackLink";

// ── Cost / latency estimates for the inline Process-button preview ─────
// Sonnet 4.6 standard tier ballpark from design §6.3. The actual telemetry
// shown on each batch card and on the profile is from live API usage.
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

export default function IntrospectDashboard({ handle }: { handle: string }) {
  const router = useRouter();
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  // True from first render so we show the loading view (not the error/retry
  // view) before the auto-fetch effect kicks in.
  const [fetching, setFetching] = useState(true);
  const [processing, setProcessing] = useState(false);
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
  // when present, so this is a no-op for revisits. setState inside the
  // async callFetch resolves outside the synchronous effect body, but the
  // lint can't see that — disable for this call.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    callFetch(false);
  }, [callFetch]);

  const onProcess = useCallback(async () => {
    if (!snapshot) return;
    setError(null);
    setInfo(null);
    setProcessing(true);
    try {
      const res = await fetch("/api/introspect/process-batch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ handle: snapshot.handle }),
      });
      const data = await res.json();
      if (!res.ok) {
        if (data.snapshot) setSnapshot(data.snapshot as Snapshot);
        setError(data.error || `process failed (${res.status})`);
        return;
      }
      setSnapshot(data.snapshot as Snapshot);
    } catch (err) {
      setError(err instanceof Error ? err.message : "process failed");
    } finally {
      setProcessing(false);
    }
  }, [snapshot]);

  const onReset = useCallback(async () => {
    if (!snapshot) return;
    if (
      !confirm(
        `Delete all stored data for @${snapshot.handle}? This will wipe stats, batch notes, and the unified profile. Cached images stay.`
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
      <main className="min-h-screen overflow-x-hidden bg-[#fafafa] text-[#1a1a1a]">
        <div className="mx-auto max-w-2xl px-4 py-12 sm:px-6 sm:py-24">
          <IntrospectBackLink />
          <h1 className="mb-3 font-serif text-3xl">introspect</h1>
          <p className="mb-2 font-mono text-sm text-[#444]">@{handle}</p>
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
      <main className="min-h-screen overflow-x-hidden bg-[#fafafa] text-[#1a1a1a]">
        <div className="mx-auto max-w-2xl px-4 py-12 sm:px-6 sm:py-24">
          <IntrospectBackLink />
          <h1 className="mb-3 font-serif text-3xl">introspect</h1>
          <p className="mb-4 font-mono text-sm text-[#444]">@{handle}</p>
          {error && (
            <p className="mb-4 border-l-2 border-red-700 bg-red-50 px-3 py-2 text-sm text-red-700">
              {error}
            </p>
          )}
          <div className="flex flex-col gap-2 sm:flex-row">
            <button
              type="button"
              onClick={() => callFetch(false)}
              className="min-h-11 rounded bg-[#1a1a1a] px-4 py-2 text-white sm:min-h-0"
            >
              Retry
            </button>
            <button
              type="button"
              onClick={() => router.push("/introspect")}
              className="min-h-11 rounded border border-[#ddd] px-4 py-2 sm:min-h-0"
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
      processing={processing}
      fetching={fetching}
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
  processing,
  fetching,
  info,
  error,
  onProcess,
  onReset,
  onRefresh,
}: {
  snapshot: Snapshot;
  processing: boolean;
  fetching: boolean;
  info: string | null;
  error: string | null;
  onProcess: () => void;
  onReset: () => void;
  onRefresh: () => void;
}) {
  const { batches, batchNotes, profile, callHistory } = snapshot;
  const processedCount = Object.keys(batchNotes).length;
  const totalBatches = batches.length;
  const remaining = totalBatches - processedCount;
  const allDone = remaining === 0;

  const sessionSpend = useMemo(
    () => callHistory.reduce((sum, t) => sum + t.costUsd, 0),
    [callHistory]
  );
  const estimateToFinish = useMemo(
    () => remaining * (EST_EXTRACTOR_USD + EST_AGGREGATOR_USD),
    [remaining]
  );
  const perClickCost = EST_EXTRACTOR_USD + EST_AGGREGATOR_USD;

  return (
    <main className="min-h-screen overflow-x-hidden bg-[#fafafa] text-[#1a1a1a]">
      <div className="mx-auto max-w-4xl px-4 py-6 sm:px-6 sm:py-10">
        <IntrospectBackLink />
        <header className="mb-6 flex flex-col gap-4 border-b border-[#1a1a1a] pb-4 sm:flex-row sm:items-baseline sm:justify-between">
          <div className="min-w-0">
            <h1 className="font-serif text-3xl tracking-tight">introspect</h1>
            <p className="mt-1 text-[#444]">
              <span className="font-mono break-all">@{snapshot.handle}</span>
              <span className="mt-1 block text-sm text-[#888] sm:mt-0 sm:ml-3 sm:inline">
                last refreshed {relativeTime(snapshot.fetchedAt)}
              </span>
            </p>
          </div>
          <div className="flex shrink-0 flex-col gap-2 text-sm sm:flex-row">
            <button
              type="button"
              onClick={onRefresh}
              disabled={fetching || processing}
              className="min-h-10 rounded border border-[#1a1a1a] px-3 py-2 hover:bg-[#1a1a1a] hover:text-white disabled:opacity-50 sm:min-h-0 sm:py-1.5"
            >
              {fetching ? "Refreshing…" : "Refresh from PDS"}
            </button>
            <button
              type="button"
              onClick={onReset}
              disabled={fetching || processing}
              className="min-h-10 rounded border border-[#ddd] px-3 py-2 text-[#666] hover:border-red-700 hover:text-red-700 disabled:opacity-50 sm:min-h-0 sm:py-1.5"
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

        <StatsPanel snapshot={snapshot} />

        {totalBatches > 0 && (
          <section className="my-8">
            <div className="flex flex-col items-stretch gap-3 border-t border-[#ddd] pt-6">
              <div className="flex flex-col gap-2 text-sm text-[#444] sm:flex-row sm:items-baseline sm:justify-between">
                <span>
                  <strong className="text-[#1a1a1a]">Batch notes:</strong>{" "}
                  {processedCount} of {totalBatches} processed (newest-first)
                </span>
                <span className="text-[#666]">
                  Spent this session:{" "}
                  <span className="font-mono">${sessionSpend.toFixed(2)}</span>
                  {!allDone && (
                    <>
                      {" "}· est. to finish all:{" "}
                      <span className="font-mono">
                        ~${estimateToFinish.toFixed(2)}
                      </span>
                    </>
                  )}
                </span>
              </div>
              <button
                type="button"
                onClick={onProcess}
                disabled={
                  processing || fetching || (allDone && profile !== null)
                }
                className="w-full rounded-lg bg-[#1a1a1a] px-3 py-3 text-base font-medium leading-snug text-white hover:bg-[#000] disabled:cursor-not-allowed disabled:opacity-50 sm:text-lg"
              >
                {processing
                  ? "Processing… (Extractor + Aggregator)"
                  : allDone && profile !== null
                    ? "All batches processed"
                    : allDone && profile === null
                      ? `Retry Aggregator only (~$${EST_AGGREGATOR_USD.toFixed(2)}, ~5s)`
                      : `Process next batch (${remaining} remaining · ~$${perClickCost.toFixed(2)} · ~${EST_PER_CLICK_S}s)`}
              </button>
            </div>
          </section>
        )}

        {totalBatches > 0 && (
          <section className="my-8">
            <h2 className="text-xl font-serif mb-4 border-b border-[#ddd] pb-2">
              Batch notes
            </h2>
            <div className="space-y-4">
              {batches.map((b) => (
                <BatchCard key={b.index} batch={b} note={batchNotes[b.index]} />
              ))}
            </div>
          </section>
        )}

        <section className="my-8">
          <h2 className="text-xl font-serif mb-4 border-b border-[#ddd] pb-2">
            Unified profile
          </h2>
          {profile ? (
            <ProfilePanel
              profile={profile}
              processedCount={processedCount}
              totalBatches={totalBatches}
            />
          ) : (
            <p className="text-[#666] italic">
              Process at least one batch to generate the unified profile.
            </p>
          )}
        </section>

        {snapshot.feedSeedPrompts && snapshot.feedSeedPrompts.prompts.length > 0 && (
          <SuggestedFeeds seeds={snapshot.feedSeedPrompts} />
        )}
      </div>
    </main>
  );
}

// ── Suggested feeds ────────────────────────────────────────────────────

function SuggestedFeeds({ seeds }: { seeds: FeedSeedPrompts }) {
  const router = useRouter();
  return (
    <section className="my-8">
      <h2 className="text-xl font-serif mb-1 border-b border-[#ddd] pb-2">
        Suggested feeds
      </h2>
      <p className="mb-4 mt-2 flex flex-col gap-2 text-xs text-[#888] sm:flex-row sm:items-center">
        <span>
          Click one to open the curator on a fresh feed with this prompt
          pre-filled. You still hit send.
        </span>
        <CallChip telemetry={seeds.telemetry} />
      </p>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        {seeds.prompts.map((prompt, i) => (
          <button
            key={i}
            type="button"
            onClick={() => {
              router.push(
                `/curator?new=1&prompt=${encodeURIComponent(prompt)}`
              );
            }}
            className="rounded border border-[#e0e0e0] bg-white p-4 text-left transition-colors hover:border-[#1a1a1a] hover:bg-[#fafafa]"
          >
            <p className="text-[15px] leading-relaxed text-[#1a1a1a]">
              {prompt}
            </p>
            <p className="text-[11px] text-[#888] font-mono mt-2">
              Open curator →
            </p>
          </button>
        ))}
      </div>
    </section>
  );
}

// ── Stats panel ────────────────────────────────────────────────────────

function StatsPanel({ snapshot }: { snapshot: Snapshot }) {
  const { stats } = snapshot;
  if (stats.total === 0) {
    return (
      <section className="my-6 p-4 bg-amber-50 border-l-2 border-amber-500 text-sm">
        No engagements found for this handle yet — come back after more activity.
      </section>
    );
  }
  return (
    <section className="my-6 rounded border border-[#e8e8e8] bg-white p-4 sm:p-5">
      <h2 className="mb-1 font-serif text-lg">Engagement stats</h2>
      <p className="text-xs text-[#888] mb-4">
        Deterministic — computed locally, never sent to the LLM.
      </p>
      <p className="mb-4 text-sm leading-relaxed">
        <strong>{stats.total.toLocaleString()}</strong> engagements over{" "}
        <strong>{stats.spanDays}</strong> days · {stats.avgPerDay}/day average ·{" "}
        <span className="text-[#666]">
          {fmtDate(stats.rangeStart)} → {fmtDate(stats.rangeEnd)}
        </span>
      </p>

      <div className="space-y-1.5 mb-5">
        {SIGNAL_ORDER.map((t) => {
          const row = stats.byType[t];
          if (row.count === 0) return null;
          const imgPct = stats.imagePctByType[t];
          const linkPct = stats.linkCardPctByType[t];
          return (
            <SignalBar
              key={t}
              label={SIGNAL_LABELS[t]}
              count={row.count}
              pct={row.pct}
              max={Math.max(...SIGNAL_ORDER.map((s) => stats.byType[s].pct))}
              extras={
                t === "like"
                  ? `${imgPct ?? 0}% w/ images · ${linkPct ?? 0}% w/ link cards`
                  : t === "quote"
                    ? `avg commentary: ${stats.avgQuoteWords} words`
                    : t === "reply"
                      ? `avg length: ${stats.avgReplyWords} words`
                      : ""
              }
            />
          );
        })}
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mb-5 text-xs">
        <RatioCard
          name="repost : like"
          value={stats.ratios.repostToLike}
          hint={ratioHint("repostToLike", stats.ratios.repostToLike)}
        />
        <RatioCard
          name="quote : repost"
          value={stats.ratios.quoteToRepost}
          hint={ratioHint("quoteToRepost", stats.ratios.quoteToRepost)}
        />
        <RatioCard
          name="own : consumed"
          value={stats.ratios.ownToConsumed}
          hint={ratioHint("ownToConsumed", stats.ratios.ownToConsumed)}
        />
      </div>

      <p className="text-sm mb-4">
        <strong>Last 30 days:</strong> {stats.recent30d.count} engagements
        {stats.recent30d.pctChange !== null && (
          <span
            className={
              stats.recent30d.pctChange >= 0
                ? "text-emerald-700"
                : "text-amber-700"
            }
          >
            {" "}({stats.recent30d.pctChange >= 0 ? "↑" : "↓"}
            {Math.abs(stats.recent30d.pctChange)}% vs prior trailing avg of{" "}
            {stats.recent30d.priorAvg30d})
          </span>
        )}
      </p>

      {stats.topAccounts.length > 0 && (
        <div>
          <h3 className="mb-2 text-sm font-semibold">
            Top engaged-with accounts
          </h3>
          <div className="-mx-1 overflow-x-auto px-1">
          <table className="w-full min-w-[280px] text-xs font-mono">
            <tbody>
              {stats.topAccounts.map((a) => (
                <tr key={a.handle}>
                  <td className="max-w-[9rem] truncate py-1 pr-3 sm:max-w-none">{a.handle}</td>
                  <td className="py-1 pr-3 text-right whitespace-nowrap">{a.total}</td>
                  <td className="py-1 text-[#666] whitespace-nowrap">
                    {(["like", "repost", "quote", "reply"] as SignalType[])
                      .map((t) => {
                        const n = a.byType[t] ?? 0;
                        if (n === 0) return null;
                        const letter =
                          t === "like"
                            ? "L"
                            : t === "repost"
                              ? "R"
                              : t === "quote"
                                ? "Q"
                                : "Rp";
                        return `${n}${letter}`;
                      })
                      .filter(Boolean)
                      .join("  ")}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          </div>
          <p className="mt-2 text-[10px] text-[#999]">
            L=like  R=repost  Q=quote  Rp=reply-to
          </p>
        </div>
      )}

      {stats.unavailableCount > 0 && (
        <p className="text-xs text-[#888] mt-3 italic">
          {stats.unavailableCount} engaged-with subjects unavailable (deleted,
          blocked, or 404).
        </p>
      )}
    </section>
  );
}

function SignalBar({
  label,
  count,
  pct,
  max,
  extras,
}: {
  label: string;
  count: number;
  pct: number;
  max: number;
  extras: string;
}) {
  const widthPct = max > 0 ? (pct / max) * 100 : 0;
  return (
    <div className="space-y-1 text-sm">
      <div className="flex items-center justify-between gap-3">
        <span className="text-[#444]">{label}</span>
        <span className="shrink-0 text-xs font-mono text-[#444]">
          {count.toLocaleString()} ({pct}%)
        </span>
      </div>
      <div className="relative h-5 overflow-hidden rounded-sm bg-[#f0f0f0]">
        <div
          className="absolute inset-y-0 left-0 bg-[#1a1a1a]"
          style={{ width: `${widthPct}%` }}
        />
      </div>
      {extras && (
        <p className="text-[11px] leading-snug text-[#888]">{extras}</p>
      )}
    </div>
  );
}

function RatioCard({
  name,
  value,
  hint,
}: {
  name: string;
  value: number | null;
  hint: string;
}) {
  return (
    <div className="border border-[#eee] rounded p-2.5 bg-[#fafafa]">
      <div className="font-mono text-[10px] text-[#666]">{name}</div>
      <div className="font-mono text-base text-[#1a1a1a] mt-0.5">
        {value === null ? "—" : value.toFixed(2)}
      </div>
      <div className="text-[10px] text-[#888] leading-tight mt-1">{hint}</div>
    </div>
  );
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

// ── Batch card ─────────────────────────────────────────────────────────

function BatchCard({
  batch,
  note,
}: {
  batch: BatchInfo;
  note: BatchNote | undefined;
}) {
  return (
    <div className="rounded border border-[#e0e0e0] bg-white">
      <div className="space-y-1.5 border-b border-[#eee] px-3 py-2.5 font-mono text-xs text-[#666] sm:px-4">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
          <span className="font-semibold text-[#1a1a1a]">Batch {batch.index}</span>
          <span className="hidden text-[#ccc] sm:inline">·</span>
          <span>
            covers {fmtDate(batch.startTs)} → {fmtDate(batch.endTs)}
          </span>
          <span className="hidden text-[#ccc] sm:inline">·</span>
          <span>{batch.engagementIds.length} records</span>
        </div>
        <div className="break-words leading-relaxed text-[#888]">
          <span>Mix: </span>
          {SIGNAL_ORDER.map((t) => {
            const n = batch.mix[t];
            if (n === 0) return null;
            return `${n} ${SIGNAL_LABELS[t]}`;
          })
            .filter(Boolean)
            .join(" · ")}
          {note && (
            <>
              <span className="mt-1 block sm:mt-0 sm:inline">
                {" — Extractor: "}
                <CallChip telemetry={note.telemetry} />
              </span>
              {note.imagesAttached > 0 && (
                <span> · {note.imagesAttached} images</span>
              )}
              {note.imagesFailed > 0 && (
                <span className="text-amber-700">
                  {" "}· {note.imagesFailed} failed
                </span>
              )}
            </>
          )}
        </div>
      </div>
      <div className="px-3 py-3 text-[#1a1a1a] sm:px-4">
        {note ? (
          <MarkdownBody text={note.text} />
        ) : (
          <p className="text-[#999] italic text-sm">
            Not yet processed. Click <em>Process next batch</em> above to
            extract this one.
          </p>
        )}
      </div>
    </div>
  );
}

function ProfilePanel({
  profile,
  processedCount,
  totalBatches,
}: {
  profile: {
    text: string;
    telemetry: CallTelemetry;
    fromBatchIndices: number[];
  };
  processedCount: number;
  totalBatches: number;
}) {
  return (
    <div className="rounded border border-[#1a1a1a] bg-white p-4 sm:p-5">
      <div className="mb-3 flex flex-col gap-2 font-mono text-xs text-[#666] sm:flex-row sm:justify-between">
        <span>
          {processedCount < totalBatches && (
            <span className="text-amber-700 mr-2">
              partial — {processedCount} of {totalBatches} batches
            </span>
          )}
          Aggregator: <CallChip telemetry={profile.telemetry} />
        </span>
      </div>
      <MarkdownBody text={profile.text} />
    </div>
  );
}

function CallChip({ telemetry }: { telemetry: CallTelemetry }) {
  return (
    <span className="inline break-words text-[10px] text-[#1a1a1a] sm:text-xs">
      ${telemetry.costUsd.toFixed(3)} ·{" "}
      {(telemetry.latencyMs / 1000).toFixed(1)}s ·{" "}
      {telemetry.inputTokens.toLocaleString()}→
      {telemetry.outputTokens.toLocaleString()} tok
    </span>
  );
}

/**
 * Renders the model's prose output. Both Extractor and Aggregator return
 * markdown — headers, bold, italics, lists — so plain text wrapping would
 * lose structure. Tailwind classes restyle each element for the page look.
 */
function MarkdownBody({ text }: { text: string }) {
  return (
    <div className="prose-introspect break-words text-[15px] leading-relaxed text-[#1a1a1a] [overflow-wrap:anywhere]">
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
          em: (props) => <em className="italic text-[#333]" {...props} />,
          code: (props) => (
            <code
              className="block max-w-full overflow-x-auto whitespace-pre-wrap break-words rounded bg-[#f4f4f4] px-1.5 py-0.5 font-mono text-[0.9em] text-[#333] sm:inline sm:whitespace-normal"
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
              className="text-[#1a1a1a] underline decoration-[#bbb] hover:decoration-[#1a1a1a]"
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
