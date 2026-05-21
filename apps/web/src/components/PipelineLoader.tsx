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
  // Counts surfaced under the active step. Populated from the stream payload
  // on the "thinking" stage and held for subsequent stages.
  candidates?: number;  // candidates actually sent to the LLM (post-cap)
  hits?: number;        // total vector-search hits (pre-cap), so the UI can
                        // show "80 / 117" when truncation kicked in
  images?: number;
  model?: string;
  // Posts written by the model so far. Optional — when omitted, the
  // ranking sub-line just shows the elapsed timer.
  written?: number;
  topK?: number;
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
  return (ms / 1000).toFixed(1) + "s";
}

/**
 * Three-stage horizontal pipeline loader. Stages: Searching → Ranking →
 * Generating. Each step has a top row (dot + label) and a sub row (live
 * elapsed + counts when active, total ms when done, "queued" when pending).
 *
 * The component tracks per-stage start/end timestamps internally; the
 * caller only needs to push the current `stage`.
 */
export default function PipelineLoader(props: PipelineLoaderProps) {
  const { stage, candidates, hits, images, model, written, topK } = props;
  const [now, setNow] = useState(() => performance.now());
  const timingsRef = useRef<StageTimings>({});

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

  // Drive the live timer at ~10 Hz while a step is active.
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

  // ---- Searching ----
  const s0Cls =
    stage === "searching"
      ? "active"
      : T.searching_ended_ms !== undefined
      ? "done"
      : "";
  const s0Sub =
    stage === "searching" && T.searching_started_ms !== undefined ? (
      <>
        <span className="cur-pl-accent">{fmtSec(now - T.searching_started_ms)}</span>
        <span className="cur-pl-detail">embed · ANN · hydrate</span>
      </>
    ) : T.searching_ended_ms !== undefined && T.searching_started_ms !== undefined ? (
      <span className="cur-pl-muted">{fmtSec(T.searching_ended_ms - T.searching_started_ms)}</span>
    ) : (
      <span className="cur-pl-muted">queued</span>
    );

  // Format candidate count, e.g. "80 / 117" when truncation kicked in,
  // otherwise just "117 candidates" (no cap applied).
  const candCountStr =
    candidates !== undefined && hits !== undefined && hits > candidates
      ? `${candidates} / ${hits} candidates`
      : candidates !== undefined
      ? `${candidates} candidates`
      : hits !== undefined
      ? `${hits} candidates`
      : "";

  // ---- Thinking ----
  const s1Cls =
    stage === "thinking"
      ? "active"
      : T.thinking_ended_ms !== undefined
      ? "done"
      : "";
  let s1Sub: React.ReactNode;
  if (stage === "thinking" && T.thinking_started_ms !== undefined) {
    s1Sub = (
      <>
        <span className="cur-pl-accent">{fmtSec(now - T.thinking_started_ms)}</span>
        {candCountStr ? ` · ${candCountStr}` : ""}
        {images !== undefined && images > 0 ? ` · ${images} images` : ""}
        <span className="cur-pl-detail">{model ?? ""}</span>
      </>
    );
  } else if (T.thinking_ended_ms !== undefined && T.thinking_started_ms !== undefined) {
    s1Sub = (
      <span className="cur-pl-muted">
        {fmtSec(T.thinking_ended_ms - T.thinking_started_ms)}
        {candCountStr ? ` · ${candCountStr}` : ""}
      </span>
    );
  } else {
    s1Sub = <span className="cur-pl-muted">queued</span>;
  }

  // ---- Ranking (model emitting the sorted output) ----
  const s2Cls =
    stage === "ranking"
      ? "active gen"
      : T.ranking_ended_ms !== undefined
      ? "done"
      : "";
  let s2Sub: React.ReactNode;
  if (stage === "ranking" && T.ranking_started_ms !== undefined) {
    const wCount =
      typeof topK === "number"
        ? `${typeof written === "number" ? written : "…"} / ${topK}`
        : "";
    s2Sub = (
      <>
        <span className="cur-pl-accent">{fmtSec(now - T.ranking_started_ms)}</span>
        {wCount ? ` · ${wCount}` : ""}
        <span className="cur-pl-detail">streaming output</span>
      </>
    );
  } else if (T.ranking_ended_ms !== undefined && T.ranking_started_ms !== undefined) {
    const postCount = typeof topK === "number" ? `${topK} posts` : "done";
    s2Sub = (
      <span className="cur-pl-muted">
        {fmtSec(T.ranking_ended_ms - T.ranking_started_ms)} · {postCount}
      </span>
    );
  } else {
    s2Sub = <span className="cur-pl-muted">queued</span>;
  }

  const sep0Filled = T.searching_ended_ms !== undefined;
  const sep1Filled = T.thinking_ended_ms !== undefined;

  const totalStart = T.searching_started_ms ?? now;
  const totalEnd = isDone
    ? T.ranking_ended_ms ?? T.thinking_ended_ms ?? T.searching_ended_ms ?? now
    : now;

  return (
    <div className="cur-pl">
      <div className={`cur-pl-step ${s0Cls}`}>
        <div className="cur-pl-top"><span className="cur-pl-dot" />Searching</div>
        <div className="cur-pl-sub">{s0Sub}</div>
      </div>
      <div className={`cur-pl-sep ${sep0Filled ? "filled" : ""}`} />
      <div className={`cur-pl-step ${s1Cls}`}>
        <div className="cur-pl-top"><span className="cur-pl-dot" />Thinking</div>
        <div className="cur-pl-sub">{s1Sub}</div>
      </div>
      <div className={`cur-pl-sep ${sep1Filled ? "filled" : ""}`} />
      <div className={`cur-pl-step ${s2Cls}`}>
        <div className="cur-pl-top"><span className="cur-pl-dot" />Ranking</div>
        <div className="cur-pl-sub">{s2Sub}</div>
      </div>
      <div className="cur-pl-timer">{fmtSec(totalEnd - totalStart)}</div>
    </div>
  );
}
