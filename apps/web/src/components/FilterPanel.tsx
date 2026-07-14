"use client";

import { useState, useEffect, useLayoutEffect, useCallback, useRef } from "react";
import type { MechanicalFilters, TimeWindow } from "@/lib/types";
import {
  DEFAULT_MECHANICAL_FILTERS,
  DEFAULT_SENSITIVE_LABELS,
  DEFAULT_CANDIDATE_BUDGET,
  DEFAULT_RERANK_MODEL,
  MIN_CANDIDATE_BUDGET,
  MAX_CANDIDATE_BUDGET,
  RERANK_MODEL_OPTIONS,
  MIN_RECENCY_HALFLIFE_H,
  MAX_RECENCY_HALFLIFE_H,
} from "@/lib/defaults";

interface FilterPanelProps {
  mechanicalFilters: MechanicalFilters;
  subqueries: string[];
  candidateBudget: number;
  rerankPrompt: string;
  rerankModel: string;
  rerankThinkingEnabled: boolean;
  engagementWeight: number;
  recencyWeight: number;
  recencyHalflifeH: number;
  onMechanicalChange: (filters: MechanicalFilters) => void;
  onSubqueriesChange: (subs: string[]) => void;
  onCandidateBudgetChange: (n: number) => void;
  onRerankModelChange: (model: string) => void;
  onRerankThinkingChange: (enabled: boolean) => void;
  onEngagementWeightChange: (n: number) => void;
  onRecencyWeightChange: (n: number) => void;
  onRecencyHalflifeChange: (n: number) => void;
  postCount: number;
  rightPane?: "chat" | "tune";
  onRightPaneChange?: (pane: "chat" | "tune") => void;
  onClose?: () => void;
  style?: React.CSSProperties;
}

const MAX_SUBQUERIES = 4;

// Trailing-edge debounce that survives re-renders (timer in a ref, not state)
// and clears any pending call on unmount. One helper for every debounced save.
function useDebouncedCallback<A extends unknown[]>(
  fn: (...args: A) => void,
  delay: number
): (...args: A) => void {
  const fnRef = useRef(fn);
  useEffect(() => {
    fnRef.current = fn;
  }, [fn]);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    []
  );
  return useCallback(
    (...args: A) => {
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => fnRef.current(...args), delay);
    },
    [delay]
  );
}

export default function FilterPanel({
  mechanicalFilters,
  subqueries,
  candidateBudget,
  rerankPrompt,
  rerankModel,
  rerankThinkingEnabled,
  engagementWeight,
  recencyWeight,
  recencyHalflifeH,
  onMechanicalChange,
  onSubqueriesChange,
  onCandidateBudgetChange,
  onRerankModelChange,
  onRerankThinkingChange,
  onEngagementWeightChange,
  onRecencyWeightChange,
  onRecencyHalflifeChange,
  postCount,
  rightPane,
  onRightPaneChange,
  onClose,
  style,
}: FilterPanelProps) {
  const [mech, setMech] = useState<MechanicalFilters>({
    ...DEFAULT_MECHANICAL_FILTERS,
    ...mechanicalFilters,
  });
  const [subs, setSubs] = useState<string[]>(subqueries ?? []);
  const [budget, setBudget] = useState<number>(candidateBudget || DEFAULT_CANDIDATE_BUDGET);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [safetyOpen, setSafetyOpen] = useState(false);
  const [recSysOpen, setRecSysOpen] = useState(false);

  // Ranking-bias local state (mirrors props; debounced saves on change).
  const [engW, setEngW] = useState<number>(engagementWeight);
  const [recW, setRecW] = useState<number>(recencyWeight);
  const [halflife, setHalflife] = useState<number>(recencyHalflifeH);

  useEffect(() => {
    setMech({ ...DEFAULT_MECHANICAL_FILTERS, ...mechanicalFilters });
  }, [mechanicalFilters]);

  useEffect(() => {
    setSubs(subqueries ?? []);
  }, [subqueries]);

  useEffect(() => {
    setBudget(candidateBudget || DEFAULT_CANDIDATE_BUDGET);
  }, [candidateBudget]);

  useEffect(() => setEngW(engagementWeight), [engagementWeight]);
  useEffect(() => setRecW(recencyWeight), [recencyWeight]);
  useEffect(() => setHalflife(recencyHalflifeH), [recencyHalflifeH]);

  // Debounced saves (one shared hook, trailing-edge).
  const saveMech = useDebouncedCallback(onMechanicalChange, 600);
  const saveSubs = useDebouncedCallback(onSubqueriesChange, 600);
  const saveBudget = useDebouncedCallback(onCandidateBudgetChange, 600);
  const saveEngW = useDebouncedCallback(onEngagementWeightChange, 500);
  const saveRecW = useDebouncedCallback(onRecencyWeightChange, 500);
  const saveHalflife = useDebouncedCallback(onRecencyHalflifeChange, 500);

  function updateMech(patch: Partial<MechanicalFilters>) {
    const updated = { ...mech, ...patch };
    setMech(updated);
    saveMech(updated);
  }

  function updateMechList(
    field: keyof MechanicalFilters,
    value: string,
    action: "add" | "remove"
  ) {
    const list = [...(mech[field] as string[])];
    if (action === "add" && value.trim() && !list.includes(value.trim())) {
      list.push(value.trim());
    } else if (action === "remove") {
      const idx = list.indexOf(value);
      if (idx >= 0) list.splice(idx, 1);
    }
    updateMech({ [field]: list });
  }

  function updateSubqueries(next: string[]) {
    setSubs(next);
    saveSubs(next);
  }

  function updateBudget(n: number) {
    const clamped = Math.max(
      MIN_CANDIDATE_BUDGET,
      Math.min(MAX_CANDIDATE_BUDGET, Math.round(n))
    );
    setBudget(clamped);
    saveBudget(clamped);
  }

  // Ranking-bias updaters (immediate local state, debounced PATCH).
  function updateEngW(n: number) {
    setEngW(n);
    saveEngW(n);
  }
  function updateRecW(n: number) {
    setRecW(n);
    saveRecW(n);
  }
  function updateHalflife(h: number) {
    setHalflife(h);
    saveHalflife(h);
  }

  const perQueryK =
    subs.length > 0 ? Math.floor(budget / subs.length) : budget;

  return (
    <div className="ctrl-tower" style={style}>
      {onRightPaneChange && (
        <div className="cur-right-toggle" role="tablist" aria-label="Workbench mode">
          <button
            type="button"
            role="tab"
            aria-selected={rightPane === "chat"}
            className={`cur-right-seg${rightPane === "chat" ? " active" : ""}`}
            onClick={() => onRightPaneChange("chat")}
          >
            Chat
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={rightPane === "tune"}
            className={`cur-right-seg${rightPane === "tune" ? " active" : ""}`}
            onClick={() => onRightPaneChange("tune")}
          >
            Tune
          </button>
        </div>
      )}
      <div className="ctrl-header">
        <div className="ctrl-title">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <line x1="4" y1="6" x2="20" y2="6" /><line x1="4" y1="12" x2="20" y2="12" /><line x1="4" y1="18" x2="20" y2="18" />
          </svg>
          Tune feed
        </div>
        <div className="ctrl-stat">
          <span className="ctrl-stat-num">{postCount}</span>
          <span className="ctrl-stat-label">posts matched</span>
        </div>
        {onClose && (
          <button type="button" className="ctrl-close" onClick={onClose} aria-label="Close tune panel">
            <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M18 6 6 18M6 6l12 12" /></svg>
          </button>
        )}
      </div>

      <div className="ctrl-body">
        <div className="ctrl-section-group">
          {/* FILTERS */}
          <div className="ctrl-section">
            <label className="ctrl-label">Time window</label>
            <div className="ctrl-pill-group">
              {(
                [
                  ["1h", "1h"],
                  ["24h", "24h"],
                  ["3d", "3d"],
                  ["7d", "7d"],
                  ["custom", "Custom"],
                ] as Array<[TimeWindow, string]>
              ).map(([value, label]) => (
                <button
                  key={value}
                  className={`ctrl-pill ${mech.time_window === value ? "active" : ""}`}
                  onClick={() => updateMech({ time_window: value })}
                >
                  {label}
                </button>
              ))}
            </div>
            {mech.time_window === "custom" && (
              <div className="ctrl-inline-inputs" style={{ marginTop: 8 }}>
                <div className="ctrl-mini-field">
                  <span>From</span>
                  <input
                    type="date"
                    value={isoToDateInput(mech.created_after_iso)}
                    onChange={(e) =>
                      updateMech({
                        created_after_iso: dateInputToIso(e.target.value, "start"),
                      })
                    }
                  />
                </div>
                <div className="ctrl-mini-field">
                  <span>To</span>
                  <input
                    type="date"
                    value={isoToDateInput(mech.created_before_iso)}
                    onChange={(e) =>
                      updateMech({
                        created_before_iso: dateInputToIso(e.target.value, "end"),
                      })
                    }
                  />
                </div>
              </div>
            )}
          </div>

          <div className="ctrl-section">
            <label className="ctrl-label">Include</label>
            <div className="ctrl-pill-group">
              {(["all", "top_level", "replies"] as const).map((t) => (
                <button
                  key={t}
                  className={`ctrl-pill ${mech.post_type === t ? "active" : ""}`}
                  onClick={() => updateMech({ post_type: t })}
                >
                  {t === "all" ? "All" : t === "top_level" ? "Posts only" : "Replies only"}
                </button>
              ))}
            </div>
          </div>

          {/* CONTENT — one tri-state sentence dropdown per media type; maps
              1:1 to the nullable has_images/has_video/has_external_link KNN
              filters (require = true, hide = false, show all = null). */}
          <div className="ctrl-section">
            <label className="ctrl-label">Content</label>
            <div className="ctrl-field-rows">
              <div className="ctrl-mini-field">
                <span>Images</span>
                <select
                  value={triState(mech.require_media, mech.exclude_media)}
                  onChange={(e) =>
                    updateMech(
                      triPatch("require_media", "exclude_media", e.target.value as TriState)
                    )
                  }
                >
                  <option value="any">Show all posts</option>
                  <option value="require">Only posts with images</option>
                  <option value="exclude">Hide posts with images</option>
                </select>
              </div>
              <div className="ctrl-mini-field">
                <span>Video</span>
                <select
                  value={triState(mech.require_video, mech.exclude_video)}
                  onChange={(e) =>
                    updateMech(
                      triPatch("require_video", "exclude_video", e.target.value as TriState)
                    )
                  }
                >
                  <option value="any">Show all posts</option>
                  <option value="require">Only posts with video</option>
                  <option value="exclude">Hide posts with video</option>
                </select>
              </div>
              <div className="ctrl-mini-field">
                <span>Links</span>
                <select
                  value={triState(mech.require_link, mech.exclude_links)}
                  onChange={(e) =>
                    updateMech(
                      triPatch("require_link", "exclude_links", e.target.value as TriState)
                    )
                  }
                >
                  <option value="any">Show all posts</option>
                  <option value="require">Only posts with links</option>
                  <option value="exclude">Hide posts with links</option>
                </select>
              </div>
            </div>
          </div>

          {/* RECOMMENDATION SYSTEM — collapsible group: topics, reranker
              instructions, ranking bias */}
          <div className="ctrl-section">
            <button
              type="button"
              className={`ctrl-collapse-head${recSysOpen ? " open" : ""}`}
              onClick={() => setRecSysOpen((v) => !v)}
              aria-expanded={recSysOpen}
            >
              Recommendation system
              <span className="ctrl-collapse-meta">
                <span className="ctrl-label-value">
                  {subs.length} {subs.length === 1 ? "topic" : "topics"}
                </span>
                <svg
                  aria-hidden
                  width="11"
                  height="11"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="m6 9 6 6 6-6" />
                </svg>
              </span>
            </button>
          </div>

          {recSysOpen && (
            <>
            {/* TOPICS — the heart of the feed */}
            <div className="ctrl-section">
              <label className="ctrl-label">
                <span className="ctrl-label-text">
                  Topics
                  <InfoTip>
                    Each topic becomes a search over recent Bluesky posts. Short
                    descriptive phrases, 5 to 15 words, work best. Results from
                    all topics are pooled together, then ranked.
                  </InfoTip>
                </span>
                <span className="ctrl-label-value">
                  {subs.length} / {MAX_SUBQUERIES}
                </span>
              </label>
              <SubqueryEditor
                subqueries={subs}
                max={MAX_SUBQUERIES}
                onChange={updateSubqueries}
              />
            </div>

            {/* RERANKER — always on; agent-generated editorial prompt, per-feed */}
            <div className="ctrl-section">
              <label className="ctrl-label">
                <span className="ctrl-label-text">
                  Ranking and filtering instructions
                  <InfoTip>
                    An AI reads every post your topics matched and orders the
                    feed by these instructions, favoring what they say to favor
                    and dropping what they say to drop. The curator agent writes
                    them; to change them, ask in chat. For example, favor long
                    threads, drop engagement bait.
                  </InfoTip>
                </span>
              </label>
              {rerankPrompt.trim() ? (
                <div className="ctrl-rerank-prompt">{rerankPrompt}</div>
              ) : (
                <p className="ctrl-hint">
                  Using default instructions. Tell the agent in chat what to
                  favor or drop and it will write custom ones for this feed.
                </p>
              )}
              <div className="ctrl-mini-field">
                <span>Model</span>
                <select
                  value={rerankModel || DEFAULT_RERANK_MODEL}
                  onChange={(e) => onRerankModelChange(e.target.value)}
                >
                  {RERANK_MODEL_OPTIONS.map((opt) => (
                    <option key={opt.value} value={opt.value}>{opt.label}</option>
                  ))}
                </select>
                <InfoTip>
                  A bigger model follows the instructions more carefully but
                  refreshes slower.
                </InfoTip>
              </div>
              <Toggle
                label={
                  <>
                    Extended thinking
                    <InfoTip>
                      Lets the ranking model think longer before ordering posts.
                      Can sharpen borderline calls, but refreshes are slower.
                    </InfoTip>
                  </>
                }
                checked={rerankThinkingEnabled}
                onChange={onRerankThinkingChange}
              />
            </div>

            {/* RANKING BIAS — deterministic blend applied after the reranker */}
            <div className="ctrl-section">
              <label className="ctrl-label">
                <span className="ctrl-label-text">
                  Ranking bias
                  <InfoTip>
                    After the instructions pick the best posts, these sliders
                    nudge the order toward popular and fresh ones.
                  </InfoTip>
                </span>
              </label>

              <label className="ctrl-label">
                Engagement
                <span className="ctrl-label-value">{Math.round(engW * 100)}%</span>
              </label>
              <input
                type="range"
                className="ctrl-slider"
                min={0}
                max={1}
                step={0.05}
                value={engW}
                onChange={(e) => updateEngW(parseFloat(e.target.value))}
              />

              <label className="ctrl-label" style={{ marginTop: 12 }}>
                Recency
                <span className="ctrl-label-value">{Math.round(recW * 100)}%</span>
              </label>
              <input
                type="range"
                className="ctrl-slider"
                min={0}
                max={1}
                step={0.05}
                value={recW}
                onChange={(e) => updateRecW(parseFloat(e.target.value))}
              />
            </div>
            </>
          )}

          {/* SAFETY — visible but collapsed by default */}
          <div className="ctrl-section">
            <button
              type="button"
              className={`ctrl-collapse-head${safetyOpen ? " open" : ""}`}
              onClick={() => setSafetyOpen((v) => !v)}
              aria-expanded={safetyOpen}
            >
              Safety
              <span className="ctrl-collapse-meta">
                <span className="ctrl-label-value">
                  {mech.block_labels.length > 0 ? "filtered" : "off"}
                </span>
                <svg
                  aria-hidden
                  width="11"
                  height="11"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="m6 9 6 6 6-6" />
                </svg>
              </span>
            </button>
            {safetyOpen && (
              <div className="ctrl-safety">
                <div className="ctrl-safety-head">
                  <span className="ctrl-safety-icon" aria-hidden>
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
                    </svg>
                  </span>
                  <div className="ctrl-safety-text">
                    {mech.block_labels.length > 0 ? (
                      <>
                        <strong>Sensitive content is filtered.</strong> Posts self-labeled as one of the following are hidden:
                      </>
                    ) : (
                      <strong>Sensitive content is NOT filtered. Your feed may include adult or graphic posts.</strong>
                    )}
                  </div>
                </div>
                {mech.block_labels.length > 0 && (
                  <div className="ctrl-safety-tags">
                    {mech.block_labels.map((l) => (
                      <span key={l} className="ctrl-tag rose">{l}</span>
                    ))}
                  </div>
                )}
                <Toggle
                  label="Show sensitive content"
                  checked={mech.block_labels.length === 0}
                  onChange={(v) =>
                    updateMech({ block_labels: v ? [] : DEFAULT_SENSITIVE_LABELS })
                  }
                />
                <Toggle
                  label="Drop likely-NSFW authors (description heuristic)"
                  checked={mech.exclude_likely_nsfw}
                  onChange={(v) => updateMech({ exclude_likely_nsfw: v })}
                />
              </div>
            )}
          </div>

          {/* ADVANCED — collapsible */}
          <div className="ctrl-section">
            <button
              type="button"
              className={`ctrl-advanced-toggle${advancedOpen ? " open" : ""}`}
              onClick={() => setAdvancedOpen((v) => !v)}
              aria-expanded={advancedOpen}
            >
              Advanced
              <svg
                aria-hidden
                width="12"
                height="12"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.5"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="m6 9 6 6 6-6" />
              </svg>
            </button>
          </div>

          {advancedOpen && (
            <>
              <div className="ctrl-section">
                <label className="ctrl-label">Languages</label>
                <TagInput
                  tags={mech.lang_allow}
                  placeholder="en, es, fr..."
                  color="mist"
                  onAdd={(v) => updateMechList("lang_allow", v, "add")}
                  onRemove={(v) => updateMechList("lang_allow", v, "remove")}
                />
              </div>

              <div className="ctrl-section">
                <Toggle
                  label="Must be quote post"
                  checked={mech.require_quote}
                  onChange={(v) => updateMech({ require_quote: v })}
                />
              </div>

              <div className="ctrl-section">
                <label className="ctrl-label">
                  <span className="ctrl-label-text">
                    Recency half-life
                    <InfoTip>
                      How long until a post counts for half as much in the
                      Recency bias. Short for breaking news, long for evergreen
                      topics.
                    </InfoTip>
                  </span>
                  <span className="ctrl-label-value">{fmtHalflife(halflife)}</span>
                </label>
                <input
                  type="range"
                  className="ctrl-slider"
                  min={0}
                  max={1}
                  step={0.01}
                  value={halflifeToPos(halflife)}
                  onChange={(e) => updateHalflife(posToHalflife(parseFloat(e.target.value)))}
                />
                <div className="ctrl-slider-labels">
                  <span>{fmtHalflife(MIN_RECENCY_HALFLIFE_H)}</span>
                  <span>{fmtHalflife(MAX_RECENCY_HALFLIFE_H)}</span>
                </div>
              </div>

              <div className="ctrl-section">
                <label className="ctrl-label">
                  <span className="ctrl-label-text">
                    Candidate budget
                    <InfoTip>
                      Total posts fetched from search before ranking, split
                      across topics
                      {subs.length > 0 ? `, about ${perQueryK} per topic` : ""}.
                      More candidates can mean better picks but slower
                      refreshes.
                    </InfoTip>
                  </span>
                  <span className="ctrl-label-value">{budget}</span>
                </label>
                <input
                  type="range"
                  className="ctrl-slider"
                  min={MIN_CANDIDATE_BUDGET}
                  max={MAX_CANDIDATE_BUDGET}
                  step={10}
                  value={budget}
                  onChange={(e) => updateBudget(parseInt(e.target.value, 10))}
                />
                <div className="ctrl-slider-labels">
                  <span>{MIN_CANDIDATE_BUDGET}</span>
                  <span>{MAX_CANDIDATE_BUDGET}</span>
                </div>
              </div>

              <div className="ctrl-section">
                <label className="ctrl-label">
                  <span className="ctrl-label-text">
                    Minimum engagement
                    <InfoTip>
                      A hard floor: posts under these counts are dropped before
                      ranking. Different from the Engagement bias, which
                      reorders posts rather than dropping them.
                    </InfoTip>
                  </span>
                </label>
                <div className="ctrl-field-rows">
                  <div className="ctrl-mini-field">
                    <span>Min likes</span>
                    <input
                      type="number"
                      value={mech.min_like_count}
                      min={0}
                      placeholder="0"
                      onChange={(e) =>
                        updateMech({ min_like_count: parseInt(e.target.value) || 0 })
                      }
                    />
                  </div>
                  <div className="ctrl-mini-field">
                    <span>Min reposts</span>
                    <input
                      type="number"
                      value={mech.min_repost_count}
                      min={0}
                      placeholder="0"
                      onChange={(e) =>
                        updateMech({ min_repost_count: parseInt(e.target.value) || 0 })
                      }
                    />
                  </div>
                  <div className="ctrl-mini-field">
                    <span>Min replies</span>
                    <input
                      type="number"
                      value={mech.min_reply_count}
                      min={0}
                      placeholder="0"
                      onChange={(e) =>
                        updateMech({ min_reply_count: parseInt(e.target.value) || 0 })
                      }
                    />
                  </div>
                </div>
              </div>

              <div className="ctrl-section">
                <label className="ctrl-label">Hashtags (include)</label>
                <TagInput
                  tags={mech.hashtag_include}
                  placeholder="aiart, indiedev..."
                  color="aurora"
                  onAdd={(v) => updateMechList("hashtag_include", v, "add")}
                  onRemove={(v) => updateMechList("hashtag_include", v, "remove")}
                />
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

// --- Helpers ---

// Tri-state media filter: require/exclude booleans collapse into one select.
type TriState = "any" | "require" | "exclude";

function triState(require: boolean, exclude: boolean): TriState {
  return require ? "require" : exclude ? "exclude" : "any";
}

function triPatch(
  requireField: keyof MechanicalFilters,
  excludeField: keyof MechanicalFilters,
  state: TriState
): Partial<MechanicalFilters> {
  return {
    [requireField]: state === "require",
    [excludeField]: state === "exclude",
  };
}

function isoToDateInput(iso: string): string {
  if (!iso) return "";
  return iso.slice(0, 10);
}

function dateInputToIso(date: string, bound: "start" | "end"): string {
  if (!date) return "";
  return bound === "start" ? `${date}T00:00:00Z` : `${date}T23:59:59Z`;
}

// Recency half-life slider is logarithmic across [MIN, MAX] hours so there's
// fine control at the short (breaking-news) end. Slider position is 0..1.
const HL_LN_MIN = Math.log(MIN_RECENCY_HALFLIFE_H);
const HL_LN_MAX = Math.log(MAX_RECENCY_HALFLIFE_H);

function halflifeToPos(h: number): number {
  const clamped = Math.max(MIN_RECENCY_HALFLIFE_H, Math.min(MAX_RECENCY_HALFLIFE_H, h));
  return (Math.log(clamped) - HL_LN_MIN) / (HL_LN_MAX - HL_LN_MIN);
}

function posToHalflife(pos: number): number {
  return Math.round(Math.exp(HL_LN_MIN + (HL_LN_MAX - HL_LN_MIN) * pos));
}

function fmtHalflife(h: number): string {
  if (h < 48) return `${Math.round(h)}h`;
  const days = h / 24;
  return `${days % 1 === 0 ? days : days.toFixed(1)}d`;
}

// --- Sub-components ---

// Circular "?" that reveals a small explainer popover on hover or tap. The
// popover is position:fixed (the panel clips overflow) with viewport-clamped
// coordinates, so it can never be cut off at the panel or browser edge.
const INFOTIP_WIDTH = 230;
const INFOTIP_MARGIN = 8;

function InfoTip({ children }: { children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState({ top: 0, left: 0 });
  const wrapRef = useRef<HTMLSpanElement | null>(null);
  const btnRef = useRef<HTMLButtonElement | null>(null);
  const popRef = useRef<HTMLSpanElement | null>(null);

  function show() {
    const r = btnRef.current?.getBoundingClientRect();
    if (!r) return;
    const width = Math.min(INFOTIP_WIDTH, window.innerWidth - INFOTIP_MARGIN * 2);
    const left = Math.max(
      INFOTIP_MARGIN,
      Math.min(r.left - 10, window.innerWidth - width - INFOTIP_MARGIN)
    );
    setPos({ top: r.bottom + 7, left });
    setOpen(true);
  }

  // If the popover runs past the bottom of the viewport, flip it above the "?".
  useLayoutEffect(() => {
    if (!open) return;
    const pop = popRef.current?.getBoundingClientRect();
    const btn = btnRef.current?.getBoundingClientRect();
    if (!pop || !btn) return;
    if (pop.bottom > window.innerHeight - INFOTIP_MARGIN) {
      setPos((p) => ({
        ...p,
        top: Math.max(INFOTIP_MARGIN, btn.top - pop.height - 7),
      }));
    }
  }, [open]);

  // Close on tap/click outside (touch has no mouseleave) and on any scroll,
  // since the fixed-position popover would otherwise drift from its anchor.
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onScroll = () => setOpen(false);
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("scroll", onScroll, true);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("scroll", onScroll, true);
    };
  }, [open]);

  return (
    <span
      ref={wrapRef}
      className="ctrl-infotip"
      onMouseEnter={show}
      onMouseLeave={() => setOpen(false)}
    >
      <button
        ref={btnRef}
        type="button"
        className="ctrl-infotip-btn"
        aria-label="More info"
        onClick={(e) => {
          e.preventDefault();
          show();
        }}
      >
        ?
      </button>
      {open && (
        <span
          ref={popRef}
          className="ctrl-infotip-pop"
          role="tooltip"
          style={{ top: pos.top, left: pos.left }}
        >
          {children}
        </span>
      )}
    </span>
  );
}

function SubqueryEditor({
  subqueries,
  max,
  onChange,
}: {
  subqueries: string[];
  max: number;
  onChange: (next: string[]) => void;
}) {
  const [draft, setDraft] = useState("");
  const [editingIdx, setEditingIdx] = useState<number | null>(null);
  const [editingValue, setEditingValue] = useState("");

  function add() {
    const v = draft.trim();
    if (!v) return;
    if (subqueries.length >= max) return;
    onChange([...subqueries, v]);
    setDraft("");
  }

  function remove(i: number) {
    const next = subqueries.slice();
    next.splice(i, 1);
    onChange(next);
  }

  function startEdit(i: number) {
    setEditingIdx(i);
    setEditingValue(subqueries[i]);
  }

  function commitEdit() {
    if (editingIdx === null) return;
    const v = editingValue.trim();
    if (!v) {
      remove(editingIdx);
    } else {
      const next = subqueries.slice();
      next[editingIdx] = v;
      onChange(next);
    }
    setEditingIdx(null);
    setEditingValue("");
  }

  const atMax = subqueries.length >= max;

  return (
    <div className="ctrl-subquery-list">
      {subqueries.map((s, i) =>
        editingIdx === i ? (
          <div key={i} className="ctrl-subquery-row editing">
            <input
              autoFocus
              type="text"
              className="ctrl-subquery-input"
              value={editingValue}
              onChange={(e) => setEditingValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") { e.preventDefault(); commitEdit(); }
                else if (e.key === "Escape") { setEditingIdx(null); setEditingValue(""); }
              }}
              onBlur={commitEdit}
            />
          </div>
        ) : (
          <div key={i} className="ctrl-subquery-row">
            <button
              type="button"
              className="ctrl-subquery-text"
              onClick={() => startEdit(i)}
              title="Click to edit"
            >
              {s}
            </button>
            <button
              type="button"
              className="ctrl-subquery-remove"
              onClick={() => remove(i)}
              aria-label="Remove subquery"
              title="Remove"
            >
              <svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
                <path d="M18 6 6 18M6 6l12 12" />
              </svg>
            </button>
          </div>
        )
      )}
      {!atMax && (
        <div className="ctrl-subquery-row adder">
          <input
            type="text"
            className="ctrl-subquery-input"
            value={draft}
            placeholder={
              subqueries.length === 0
                ? "e.g. personal essays on AI and creative work"
                : "Add another subquery…"
            }
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") { e.preventDefault(); add(); }
            }}
          />
          <button
            type="button"
            className="ctrl-subquery-add"
            onClick={add}
            disabled={!draft.trim()}
            aria-label="Add subquery"
            title="Add"
          >
            <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
              <path d="M12 5v14M5 12h14" />
            </svg>
          </button>
        </div>
      )}
    </div>
  );
}

function Toggle({
  label,
  checked,
  onChange,
}: {
  label: React.ReactNode;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <label className="ctrl-toggle-row">
      <span className="ctrl-toggle-label">{label}</span>
      <span
        className={`ctrl-switch ${checked ? "on" : ""}`}
        onClick={() => onChange(!checked)}
      >
        <span className="ctrl-switch-thumb" />
      </span>
    </label>
  );
}

function TagInput({
  tags,
  placeholder,
  color,
  onAdd,
  onRemove,
}: {
  tags: string[];
  placeholder: string;
  color: "aurora" | "amber" | "rose" | "mist";
  onAdd: (v: string) => void;
  onRemove: (v: string) => void;
}) {
  const [input, setInput] = useState("");

  return (
    <div className="ctrl-tag-input">
      {tags.length > 0 && (
        <div className="ctrl-tags">
          {tags.map((t) => (
            <span key={t} className={`ctrl-tag ${color}`}>
              {t}
              <button onClick={() => onRemove(t)}>×</button>
            </span>
          ))}
        </div>
      )}
      <input
        type="text"
        value={input}
        placeholder={placeholder}
        onChange={(e) => setInput(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && input.trim()) {
            e.preventDefault();
            onAdd(input.trim());
            setInput("");
          }
        }}
      />
    </div>
  );
}
