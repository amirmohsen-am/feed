"use client";

import { useState } from "react";
import {
  type FeedToolCall,
  feedToolCallHeadline,
  feedToolCallHasDetail,
} from "@/lib/feed-tool-call";

const Check = () => (
  <svg viewBox="0 0 12 12" fill="none" aria-hidden>
    <path d="M2.5 6.2l2.2 2.2 4.8-5" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);
const Caret = () => (
  <svg viewBox="0 0 12 12" fill="none" aria-hidden>
    <path d="M4 2.5l4 3.5-4 3.5" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

// A plain (always-shown) group: a label + one line per set value.
function PlainGroup({ label, lines }: { label: string; lines: string[] }) {
  return (
    <div className="cur-fu-grp">
      <div className="cur-fu-gt">{label}</div>
      {lines.map((t, i) => (
        <div key={i} className="cur-fu-item set">
          <span className="cur-fu-m">·</span>
          <span className="cur-fu-v">{t}</span>
        </div>
      ))}
    </div>
  );
}

// A folded section (topics / ranking steer): label + "updated" that reveals its
// detail on a second tap.
function Sub({
  label,
  state,
  count,
  children,
}: {
  label: string;
  state: string;
  count?: string;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="cur-fu-sub" data-open={open || undefined}>
      <button type="button" className="cur-fu-sub-row" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        <span className="cur-fu-gt">{label}</span>
        <span className="cur-fu-state">{state}</span>
        {count && <span className="cur-fu-count">{count}</span>}
        <span className="cur-fu-caret"><Caret /></span>
      </button>
      <div className="cur-fu-sub-panel"><div className="cur-fu-sub-panel-in">{children}</div></div>
    </div>
  );
}

export default function FeedUpdateRow({ toolCall }: { toolCall: FeedToolCall }) {
  const [open, setOpen] = useState(false);
  const hasDetail = feedToolCallHasDetail(toolCall);
  const { tokens, more } = feedToolCallHeadline(toolCall);
  const label = "Feed updated";
  const summary = tokens.join(", ");

  return (
    <div className="cur-msg cur-fu" data-open={open || undefined}>
      {hasDetail ? (
        <button type="button" className="cur-fu-row" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
          <span className="cur-fu-tick"><Check /></span>
          <span className="cur-fu-summ">
            <b>{label}</b>
            {summary && <><span className="cur-fu-sep">·</span>{summary}</>}
            {more > 0 && <span className="cur-fu-more"><span className="cur-fu-sep">·</span>+{more} more</span>}
          </span>
          <span className="cur-fu-caret"><Caret /></span>
        </button>
      ) : (
        <div className="cur-fu-row cur-fu-static">
          <span className="cur-fu-tick"><Check /></span>
          <span className="cur-fu-summ">
            <b>{label}</b>
            {summary && <><span className="cur-fu-sep">·</span>{summary}</>}
          </span>
        </div>
      )}

      {hasDetail && (
        <div className="cur-fu-panel">
          <div className="cur-fu-panel-in">
            {toolCall.name !== undefined && (
              <PlainGroup label="Name" lines={[toolCall.name]} />
            )}
            {toolCall.filters && toolCall.filters.length > 0 && (
              <PlainGroup label="Filters" lines={toolCall.filters} />
            )}
            {toolCall.ranking && toolCall.ranking.length > 0 && (
              <PlainGroup label="Ranking" lines={toolCall.ranking} />
            )}
            {toolCall.topics && toolCall.topics.length > 0 && (
              <Sub label="Topics" state="updated" count={String(toolCall.topics.length)}>
                {toolCall.topics.map((t, i) => (
                  <div key={i} className="cur-fu-item set">
                    <span className="cur-fu-m">·</span>
                    <span className="cur-fu-v">{t}</span>
                  </div>
                ))}
              </Sub>
            )}
            {toolCall.steer !== undefined && (
              <Sub label="Ranking steer" state="updated">
                <div className="cur-fu-prompt">
                  <span className="cur-fu-new">
                    {toolCall.steer.trim() === "" ? "Rerank disabled." : toolCall.steer}
                  </span>
                </div>
              </Sub>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
