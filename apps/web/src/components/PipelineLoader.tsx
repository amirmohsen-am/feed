"use client";

import { useEffect, useRef, useState } from "react";

export type PipelineStage =
  | "idle"
  | "searching"
  | "thinking"
  | "ranking"
  | "done";

export interface PipelineLoaderProps {
  stage: PipelineStage;
  // Counts surfaced in the expandable breakdown. Populated from the stream
  // payload on the "thinking" stage and held for subsequent stages.
  candidates?: number;  // candidates actually sent to the LLM (post-cap)
  hits?: number;        // total vector-search hits (pre-cap), so the UI can
                        // show "80 / 117" when truncation kicked in
  images?: number;
  model?: string;
  // Whether extended thinking was actually enabled on the rerank call. When
  // false, the breakdown says so — the time we're displaying is just TTFT,
  // not real reasoning.
  thinkingEnabled?: boolean;
  // Posts written by the model so far. Optional — when omitted, the
  // ranking row just shows the elapsed timer.
  written?: number;
  topK?: number;
  // How many snapshot posts were dropped as already-seen for this viewer
  // (serve-time seen filtering). Shown in the "searching" breakdown row.
  seenFiltered?: number;
}

interface StageTimings {
  searching_started_ms?: number;
  searching_ended_ms?: number;
  thinking_started_ms?: number;
  thinking_ended_ms?: number;
  ranking_started_ms?: number;
  ranking_ended_ms?: number;
}

function fmtSec(ms: number | undefined): string {
  if (typeof ms !== "number" || !Number.isFinite(ms)) return "";
  // Durations are always ≥ 0; clamp so a tiny negative delta (e.g. a cached
  // run where `now` ticks a hair past the stored end timestamp) doesn't render
  // as "-0.0s".
  return (Math.max(0, ms) / 1000).toFixed(1) + "s";
}

const STAGE_LABEL: Record<Exclude<PipelineStage, "idle" | "done">, string> = {
  searching: "Searching",
  thinking: "Thinking",
  ranking: "Ranking",
};

/**
 * Single-line pipeline status that updates in place, chatbot style:
 * "Searching" → "Thinking" → "Ranking", with three step dots (filled = done,
 * pulsing = current) and a live elapsed timer. On completion the side dots
 * merge into one green status light and the line settles to
 * "Curated in 8.4s". The whole line is tappable — during the run and after —
 * to open the per-stage breakdown (timings, candidate counts, model).
 *
 * The component tracks per-stage start/end timestamps internally; the
 * caller only needs to push the current `stage`.
 */
export default function PipelineLoader(props: PipelineLoaderProps) {
  const { stage, candidates, hits, images, model, thinkingEnabled, written, topK, seenFiltered } = props;
  const [now, setNow] = useState(() => performance.now());
  // Tapping the line opens the breakdown; it live-updates mid-run.
  // Collapsed again on every fresh run.
  const [expanded, setExpanded] = useState(false);
  const timingsRef = useRef<StageTimings>({});

  useEffect(() => {
    if (stage === "searching") setExpanded(false);
  }, [stage]);

  // Record stage entry/exit so completed steps can show their elapsed.
  useEffect(() => {
    const t = performance.now();
    const T = timingsRef.current;
    // Detect a fresh run starting (stage went back to "searching" after a
    // previous run completed). Wipe prior timings so the next pass starts clean.
    if (stage === "searching" && T.searching_ended_ms !== undefined) {
      timingsRef.current = { searching_started_ms: t };
      setNow(t);
      return;
    }
    if (stage === "searching" && T.searching_started_ms === undefined) {
      T.searching_started_ms = t;
    }
    if ((stage === "thinking" || stage === "ranking" || stage === "done") && T.searching_ended_ms === undefined) {
      T.searching_ended_ms = t;
    }
    if (stage === "thinking" && T.thinking_started_ms === undefined) {
      T.thinking_started_ms = t;
    }
    if ((stage === "ranking" || stage === "done") && T.thinking_ended_ms === undefined) {
      T.thinking_ended_ms = t;
    }
    if (stage === "ranking" && T.ranking_started_ms === undefined) {
      T.ranking_started_ms = t;
    }
    if (stage === "done" && T.ranking_ended_ms === undefined) {
      T.ranking_ended_ms = t;
    }
    setNow(t);
  }, [stage]);

  // Drive the live timer while a step is active.
  useEffect(() => {
    if (stage === "idle" || stage === "done") return;
    let raf = 0;
    const tick = () => {
      setNow(performance.now());
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [stage]);

  if (stage === "idle") return null;

  const T = timingsRef.current;
  const isDone = stage === "done";
  const stageIdx =
    stage === "searching" ? 0 : stage === "thinking" ? 1 : stage === "ranking" ? 2 : 3;

  const totalStart = T.searching_started_ms ?? now;
  const totalEnd = isDone
    ? T.ranking_ended_ms ?? T.thinking_ended_ms ?? T.searching_ended_ms ?? now
    : now;

  // Format candidate count, e.g. "80 / 117 candidates" when truncation
  // kicked in, otherwise just "117 candidates" (no cap applied).
  const candCountStr =
    candidates !== undefined && hits !== undefined && hits > candidates
      ? `${candidates} / ${hits} candidates`
      : candidates !== undefined
      ? `${candidates} candidates`
      : hits !== undefined
      ? `${hits} candidates`
      : "";

  // ---- Breakdown rows ----
  const stageTime = (started?: number, ended?: number, live?: boolean): string =>
    live && started !== undefined
      ? fmtSec(now - started)
      : started !== undefined && ended !== undefined
      ? fmtSec(ended - started)
      : "";

  const pendingLabel = isDone ? "skipped" : "queued";
  const thinkingOff = thinkingEnabled === false;

  const thinkingDetail = [
    candCountStr,
    images !== undefined && images > 0 ? `${images} images` : "",
    thinkingOff ? "thinking off — TTFT only" : model ?? "",
  ]
    .filter(Boolean)
    .join(" · ");

  const rankingLive = stage === "ranking";
  const rankingDetail = rankingLive
    ? [
        typeof topK === "number"
          ? `${typeof written === "number" ? written : "…"} / ${topK}`
          : "",
        "streaming output",
      ]
        .filter(Boolean)
        .join(" · ")
    : typeof topK === "number"
    ? `top ${topK} · streaming output`
    : "streaming output";

  const rows = [
    {
      key: "searching",
      live: stage === "searching",
      time: stageTime(T.searching_started_ms, T.searching_ended_ms, stage === "searching"),
      detail:
        T.searching_started_ms !== undefined
          ? [
              "embed · ANN · hydrate",
              seenFiltered && seenFiltered > 0 ? `${seenFiltered} seen hidden` : "",
            ]
              .filter(Boolean)
              .join(" · ")
          : pendingLabel,
    },
    {
      key: "thinking",
      live: stage === "thinking",
      time: stageTime(T.thinking_started_ms, T.thinking_ended_ms, stage === "thinking"),
      detail: T.thinking_started_ms !== undefined ? thinkingDetail || "—" : pendingLabel,
    },
    {
      key: "ranking",
      live: rankingLive,
      time: stageTime(T.ranking_started_ms, T.ranking_ended_ms, rankingLive),
      detail: T.ranking_started_ms !== undefined ? rankingDetail : pendingLabel,
    },
  ];

  const lineText = isDone
    ? `Curated in ${fmtSec(totalEnd - totalStart)}`
    : STAGE_LABEL[stage as Exclude<PipelineStage, "idle" | "done">];

  const dotCls = (i: number): string =>
    isDone || i < stageIdx ? " on" : i === stageIdx ? " now" : "";

  return (
    <div className={`cur-pl${isDone ? " is-done" : ""}${expanded ? " open" : ""}`}>
      <button
        type="button"
        className="cur-pl-line"
        aria-expanded={expanded}
        onClick={() => setExpanded((v) => !v)}
        title={expanded ? "Hide pipeline breakdown" : "Show pipeline breakdown"}
      >
        <span className="cur-pl-glyph" aria-hidden>
          <span className={`cur-pl-pdot${dotCls(0)}`} />
          <span className={`cur-pl-pdot${dotCls(1)}`} />
          <span className={`cur-pl-pdot${dotCls(2)}`} />
        </span>
        <span className="cur-pl-text">{lineText}</span>
        <svg className="cur-pl-chevron" width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <polyline points="6 9 12 15 18 9" />
        </svg>
        {!isDone && <span className="cur-pl-time">{fmtSec(now - totalStart)}</span>}
      </button>
      {expanded && (
        <div className="cur-pl-detail">
          {rows.map((r) => (
            <div key={r.key} className={`cur-pl-row${r.live ? " live" : ""}`}>
              <span className="cur-pl-k">{r.key}</span>
              <span className="cur-pl-t">{r.time}</span>
              <span className="cur-pl-d">{r.detail}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
