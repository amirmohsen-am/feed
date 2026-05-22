"use client";

import { useState, useEffect, useCallback } from "react";
import type { MechanicalFilters, TimeWindow } from "@/lib/types";
import {
  DEFAULT_MECHANICAL_FILTERS,
  DEFAULT_SENSITIVE_LABELS,
  DEFAULT_CANDIDATE_BUDGET,
  DEFAULT_RERANK_MODEL,
  MIN_CANDIDATE_BUDGET,
  MAX_CANDIDATE_BUDGET,
  RERANK_MODEL_OPTIONS,
} from "@/lib/defaults";

interface FilterPanelProps {
  mechanicalFilters: MechanicalFilters;
  subqueries: string[];
  candidateBudget: number;
  rerankPrompt: string;
  rerankModel: string;
  rerankThinkingEnabled: boolean;
  onMechanicalChange: (filters: MechanicalFilters) => void;
  onSubqueriesChange: (subs: string[]) => void;
  onCandidateBudgetChange: (n: number) => void;
  onRerankModelChange: (model: string) => void;
  onRerankThinkingChange: (enabled: boolean) => void;
  postCount: number;
  rightPane?: "chat" | "tune";
  onRightPaneChange?: (pane: "chat" | "tune") => void;
  style?: React.CSSProperties;
}

const MAX_SUBQUERIES = 4;

export default function FilterPanel({
  mechanicalFilters,
  subqueries,
  candidateBudget,
  rerankPrompt,
  rerankModel,
  rerankThinkingEnabled,
  onMechanicalChange,
  onSubqueriesChange,
  onCandidateBudgetChange,
  onRerankModelChange,
  onRerankThinkingChange,
  postCount,
  rightPane,
  onRightPaneChange,
  style,
}: FilterPanelProps) {
  const [mech, setMech] = useState<MechanicalFilters>({
    ...DEFAULT_MECHANICAL_FILTERS,
    ...mechanicalFilters,
  });
  const [subs, setSubs] = useState<string[]>(subqueries ?? []);
  const [budget, setBudget] = useState<number>(candidateBudget || DEFAULT_CANDIDATE_BUDGET);
  const [advancedOpen, setAdvancedOpen] = useState(false);

  useEffect(() => {
    setMech({ ...DEFAULT_MECHANICAL_FILTERS, ...mechanicalFilters });
  }, [mechanicalFilters]);

  useEffect(() => {
    setSubs(subqueries ?? []);
  }, [subqueries]);

  useEffect(() => {
    setBudget(candidateBudget || DEFAULT_CANDIDATE_BUDGET);
  }, [candidateBudget]);

  // Debounced saves
  const [mechTimeout, setMechTimeout] = useState<NodeJS.Timeout | null>(null);
  const [subsTimeout, setSubsTimeout] = useState<NodeJS.Timeout | null>(null);
  const [budgetTimeout, setBudgetTimeout] = useState<NodeJS.Timeout | null>(null);

  const saveMech = useCallback(
    (updated: MechanicalFilters) => {
      if (mechTimeout) clearTimeout(mechTimeout);
      setMechTimeout(setTimeout(() => onMechanicalChange(updated), 600));
    },
    [onMechanicalChange, mechTimeout]
  );

  const saveSubs = useCallback(
    (updated: string[]) => {
      if (subsTimeout) clearTimeout(subsTimeout);
      setSubsTimeout(setTimeout(() => onSubqueriesChange(updated), 600));
    },
    [onSubqueriesChange, subsTimeout]
  );

  const saveBudget = useCallback(
    (n: number) => {
      if (budgetTimeout) clearTimeout(budgetTimeout);
      setBudgetTimeout(setTimeout(() => onCandidateBudgetChange(n), 600));
    },
    [onCandidateBudgetChange, budgetTimeout]
  );

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
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
            <circle cx="12" cy="12" r="3" />
            <path d="M12 1v4M12 19v4M4.22 4.22l2.83 2.83M16.95 16.95l2.83 2.83M1 12h4M19 12h4M4.22 19.78l2.83-2.83M16.95 7.05l2.83-2.83" />
          </svg>
          Feed Controls
        </div>
        <div className="ctrl-stat">
          <span className="ctrl-stat-num">{postCount}</span>
          <span className="ctrl-stat-label">posts matched</span>
        </div>
      </div>

      <div className="ctrl-body">
        {/* SUBQUERIES — the heart of the feed */}
        <div className="ctrl-section-group">
          <div className="ctrl-section">
            <label className="ctrl-label">
              Subqueries
              <span className="ctrl-label-value">
                {subs.length} / {MAX_SUBQUERIES}
              </span>
            </label>
            <p className="ctrl-hint" style={{ marginTop: 0, marginBottom: 10 }}>
              Short topical queries (5&ndash;15 words). Each becomes one vector search.
            </p>
            <SubqueryEditor
              subqueries={subs}
              max={MAX_SUBQUERIES}
              onChange={updateSubqueries}
            />
          </div>

          {/* FILTERS */}
          <div className="ctrl-section">
            <label className="ctrl-label">Time window</label>
            <div className="ctrl-pill-group">
              {(
                [
                  ["1h", "1h"],
                  ["24h", "24h"],
                  ["7d", "7d"],
                  ["30d", "30d"],
                  ["all", "All time"],
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

          <div className="ctrl-section">
            <label className="ctrl-label">Content</label>
            <div className="ctrl-toggle-list">
              <Toggle
                label="Must have images"
                checked={mech.require_media}
                onChange={(v) => updateMech({ require_media: v, exclude_media: false })}
              />
              <Toggle
                label="Must have video"
                checked={mech.require_video}
                onChange={(v) => updateMech({ require_video: v, exclude_video: false })}
              />
              <Toggle
                label="Must have links"
                checked={mech.require_link}
                onChange={(v) => updateMech({ require_link: v, exclude_links: false })}
              />
              <Toggle
                label="Must be quote post"
                checked={mech.require_quote}
                onChange={(v) => updateMech({ require_quote: v })}
              />
              <Toggle
                label="No image posts"
                checked={mech.exclude_media}
                onChange={(v) => updateMech({ exclude_media: v, require_media: false })}
              />
              <Toggle
                label="No video posts"
                checked={mech.exclude_video}
                onChange={(v) => updateMech({ exclude_video: v, require_video: false })}
              />
              <Toggle
                label="No link posts"
                checked={mech.exclude_links}
                onChange={(v) => updateMech({ exclude_links: v, require_link: false })}
              />
            </div>
          </div>

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

          {/* RERANKER — agent-generated, per-feed */}
          <div className="ctrl-section">
            <label className="ctrl-label">
              Reranker
              <span className="ctrl-label-value">
                {rerankPrompt.trim() ? "on" : "off"}
              </span>
            </label>
            {rerankPrompt.trim() ? (
              <>
                <div className="ctrl-rerank-prompt">{rerankPrompt}</div>
                <p className="ctrl-hint">
                  Generated by the curator agent. Ask in chat to change it.
                </p>
              </>
            ) : (
              <p className="ctrl-hint">
                Posts come back in raw vector-similarity order. Tell the agent in chat what to favor / drop and it&apos;ll write an editorial filter.
              </p>
            )}
            <div className="ctrl-mini-field">
              <span>Model</span>
              <select
                value={rerankModel || DEFAULT_RERANK_MODEL}
                onChange={(e) => onRerankModelChange(e.target.value)}
                disabled={!rerankPrompt.trim()}
              >
                {RERANK_MODEL_OPTIONS.map((opt) => (
                  <option key={opt.value} value={opt.value}>{opt.label}</option>
                ))}
              </select>
            </div>
            <Toggle
              label="Extended thinking (slower, can sharpen borderline ranks)"
              checked={rerankThinkingEnabled}
              onChange={onRerankThinkingChange}
            />
          </div>

          {/* ADVANCED — collapsible */}
          <div className="ctrl-section">
            <button
              type="button"
              className="ctrl-label"
              style={{
                background: "none",
                border: 0,
                padding: 0,
                width: "100%",
                textAlign: "left",
                cursor: "pointer",
                display: "flex",
                alignItems: "center",
                gap: 6,
                color: "inherit",
                font: "inherit",
                letterSpacing: "inherit",
                textTransform: "inherit",
              }}
              onClick={() => setAdvancedOpen((v) => !v)}
              aria-expanded={advancedOpen}
            >
              <span aria-hidden style={{ display: "inline-block", width: 10 }}>
                {advancedOpen ? "▾" : "▸"}
              </span>
              Advanced
            </button>
          </div>

          {advancedOpen && (
            <>
              <div className="ctrl-section">
                <label className="ctrl-label">
                  Candidate budget (N)
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
                <p className="ctrl-hint">
                  Total candidates fetched. Split across subqueries
                  {subs.length > 0 ? ` (≈ ${perQueryK} per subquery).` : "."}
                </p>
              </div>

              <div className="ctrl-section">
                <label className="ctrl-label">Engagement</label>
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

              <div className="ctrl-section">
                <label className="ctrl-label">Safety</label>
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
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

// --- Helpers ---

function isoToDateInput(iso: string): string {
  if (!iso) return "";
  return iso.slice(0, 10);
}

function dateInputToIso(date: string, bound: "start" | "end"): string {
  if (!date) return "";
  return bound === "start" ? `${date}T00:00:00Z` : `${date}T23:59:59Z`;
}

// --- Sub-components ---

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
              ×
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
          >
            +
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
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <label className="ctrl-toggle-row">
      <span
        className={`ctrl-switch ${checked ? "on" : ""}`}
        onClick={() => onChange(!checked)}
      >
        <span className="ctrl-switch-thumb" />
      </span>
      {label}
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
