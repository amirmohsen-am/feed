"use client";

import { type RefObject } from "react";

type CapsuleState = "idle" | "thinking" | "updated";

interface CapsuleProps {
  /** Current draft text. */
  value: string;
  onValueChange: (v: string) => void;
  /** Fire the nudge. Only called when idle with non-empty trimmed value. */
  onSend: () => void;
  /** idle → input · thinking → goo progress pill · updated → "Feed updated". */
  state: CapsuleState;
  /** Scroll-collapsed: render the compact "Refine" pill (feed placement). */
  collapsed: boolean;
  /** Conversation open — rotates the expand chevron. */
  expanded: boolean;
  placeholder: string;
  /** Expand chevron: open/close the conversation (side chat / sheet). */
  onToggleExpand: () => void;
  /** Tap while collapsed → reopen the full input. */
  onReopen: () => void;
  /** Tap the "Feed updated" pill / "see what changed" → open the conversation. */
  onUpdatedOpen: () => void;
  inputRef: RefObject<HTMLInputElement | null>;
}

/**
 * The floating feed composer ("the capsule"). One component, identical on
 * desktop and mobile — only its positioning differs by media query. It is
 * input-only: typing + send never reveals the conversation; the expand chevron
 * does. While a turn is in flight it collapses to a goo-only progress pill;
 * on scroll it collapses to the "Refine" pill.
 */
export default function Capsule({
  value,
  onValueChange,
  onSend,
  state,
  collapsed,
  expanded,
  placeholder,
  onToggleExpand,
  onReopen,
  onUpdatedOpen,
  inputRef,
}: CapsuleProps) {
  const className =
    "capsule" +
    (state === "thinking" ? " progressing thinking" : "") +
    (state === "updated" ? " progressing updated" : "") +
    (collapsed && state === "idle" && !expanded ? " c-shrink" : "");

  return (
    <form
      className={className}
      onSubmit={(e) => {
        e.preventDefault();
        if (state !== "idle") return;
        if (!value.trim()) return;
        onSend();
      }}
      onClick={() => {
        // While a turn is in flight (goo metaballs) or just after it ("Feed
        // updated"), tapping the pill opens the conversation. Works on tap too,
        // so mobile gets the same behaviour.
        if (state === "thinking" || state === "updated") {
          onUpdatedOpen();
          return;
        }
        if (collapsed) onReopen();
      }}
    >
      <div className="cap-inner">
        <span className="cap-glyph" aria-hidden />
        <input
          ref={inputRef}
          type="text"
          className="cap-field"
          value={value}
          onChange={(e) => onValueChange(e.target.value)}
          placeholder={placeholder}
          autoComplete="off"
          disabled={state !== "idle"}
        />
        <button
          type="button"
          className="cap-expand"
          title="Show conversation"
          aria-label="Show conversation"
          onClick={(e) => {
            e.stopPropagation();
            onToggleExpand();
          }}
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <path d="m18 14-6-6-6 6" />
          </svg>
        </button>
        <button type="submit" className="cap-send" aria-label="Send" disabled={!value.trim() || state !== "idle"}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <path d="M12 19V5" />
            <path d="m5 12 7-7 7 7" />
          </svg>
        </button>
      </div>

      {/* progress / "Feed updated" overlay */}
      <div className="cap-status" aria-hidden={state === "idle"}>
        <span className="st-glyph" aria-hidden />
        <span className="st-check" aria-hidden>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round"><path d="m5 13 4 4L19 7" /></svg>
        </span>
        <span className="st-text">{state === "updated" ? "Feed updated" : "Thinking"}</span>
        {state === "updated" && (
          <button
            type="button"
            className="st-detail"
            title="See what changed"
            onClick={(e) => {
              e.stopPropagation();
              onUpdatedOpen();
            }}
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="m18 14-6-6-6 6" />
            </svg>
          </button>
        )}
      </div>

      {/* collapsed "Refine" pill — ripple glyph + label */}
      <div className="cap-mini" aria-hidden>
        <span className="m-glyph" />
        <span className="m-hint">Refine</span>
      </div>

      {/* metaballs goo for the thinking pill */}
      <div className="cap-meta" aria-hidden><i /><i /><i /><i /><i /></div>
    </form>
  );
}
