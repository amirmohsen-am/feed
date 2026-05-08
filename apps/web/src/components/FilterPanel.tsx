"use client";

import { useState, useEffect, useCallback } from "react";
import type { MechanicalFilters, SemanticConfig } from "@/lib/types";
import { DEFAULT_MECHANICAL_FILTERS, DEFAULT_SEMANTIC_CONFIG } from "@/lib/defaults";

interface FilterPanelProps {
  mechanicalFilters: MechanicalFilters;
  semanticConfig: SemanticConfig;
  onMechanicalChange: (filters: MechanicalFilters) => void;
  onSemanticChange: (config: SemanticConfig) => void;
  postCount: number;
}

export default function FilterPanel({
  mechanicalFilters,
  semanticConfig,
  onMechanicalChange,
  onSemanticChange,
  postCount,
}: FilterPanelProps) {
  const [mech, setMech] = useState<MechanicalFilters>({
    ...DEFAULT_MECHANICAL_FILTERS,
    ...mechanicalFilters,
  });
  const [sem, setSem] = useState<SemanticConfig>({
    ...DEFAULT_SEMANTIC_CONFIG,
    ...semanticConfig,
  });
  const [activeTab, setActiveTab] = useState<"signal" | "gate" | "tune">("signal");

  useEffect(() => {
    setMech({ ...DEFAULT_MECHANICAL_FILTERS, ...mechanicalFilters });
  }, [mechanicalFilters]);

  useEffect(() => {
    setSem({ ...DEFAULT_SEMANTIC_CONFIG, ...semanticConfig });
  }, [semanticConfig]);

  // Debounced saves
  const [mechTimeout, setMechTimeout] = useState<NodeJS.Timeout | null>(null);
  const [semTimeout, setSemTimeout] = useState<NodeJS.Timeout | null>(null);

  const saveMech = useCallback(
    (updated: MechanicalFilters) => {
      if (mechTimeout) clearTimeout(mechTimeout);
      setMechTimeout(setTimeout(() => onMechanicalChange(updated), 600));
    },
    [onMechanicalChange, mechTimeout]
  );

  const saveSem = useCallback(
    (updated: SemanticConfig) => {
      if (semTimeout) clearTimeout(semTimeout);
      setSemTimeout(setTimeout(() => onSemanticChange(updated), 600));
    },
    [onSemanticChange, semTimeout]
  );

  function updateMech(patch: Partial<MechanicalFilters>) {
    const updated = { ...mech, ...patch };
    setMech(updated);
    saveMech(updated);
  }

  function updateSem(patch: Partial<SemanticConfig>) {
    const updated = { ...sem, ...patch };
    setSem(updated);
    saveSem(updated);
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

  function updateSemList(
    field: keyof SemanticConfig,
    value: string,
    action: "add" | "remove"
  ) {
    const list = [...(sem[field] as string[])];
    if (action === "add" && value.trim() && !list.includes(value.trim())) {
      list.push(value.trim());
    } else if (action === "remove") {
      const idx = list.indexOf(value);
      if (idx >= 0) list.splice(idx, 1);
    }
    updateSem({ [field]: list });
  }

  return (
    <div className="ctrl-tower">
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

      {/* Tab navigation */}
      <div className="ctrl-tabs">
        <button
          className={`ctrl-tab ${activeTab === "signal" ? "active" : ""}`}
          onClick={() => setActiveTab("signal")}
        >
          Signal
        </button>
        <button
          className={`ctrl-tab ${activeTab === "gate" ? "active" : ""}`}
          onClick={() => setActiveTab("gate")}
        >
          Gate
        </button>
        <button
          className={`ctrl-tab ${activeTab === "tune" ? "active" : ""}`}
          onClick={() => setActiveTab("tune")}
        >
          Tune
        </button>
      </div>

      <div className="ctrl-body">
        {/* SIGNAL TAB — Semantic controls */}
        {activeTab === "signal" && (
          <div className="ctrl-section-group">
            <div className="ctrl-section">
              <label className="ctrl-label">Topics</label>
              <TagInput
                tags={sem.topics}
                placeholder="Add a topic..."
                color="aurora"
                onAdd={(v) => updateSemList("topics", v, "add")}
                onRemove={(v) => updateSemList("topics", v, "remove")}
              />
            </div>

            <div className="ctrl-section">
              <label className="ctrl-label">Keywords</label>
              <TagInput
                tags={sem.keywords}
                placeholder="Add a keyword..."
                color="amber"
                onAdd={(v) => updateSemList("keywords", v, "add")}
                onRemove={(v) => updateSemList("keywords", v, "remove")}
              />
            </div>

            <div className="ctrl-section">
              <label className="ctrl-label">Exclude topics</label>
              <TagInput
                tags={sem.exclude_topics}
                placeholder="Filter out..."
                color="rose"
                onAdd={(v) => updateSemList("exclude_topics", v, "add")}
                onRemove={(v) => updateSemList("exclude_topics", v, "remove")}
              />
            </div>

            <div className="ctrl-section">
              <label className="ctrl-label">Vibes</label>
              <textarea
                className="ctrl-textarea"
                value={sem.vibes}
                placeholder="Describe the tone and feel you want..."
                rows={3}
                onChange={(e) => updateSem({ vibes: e.target.value })}
              />
            </div>
          </div>
        )}

        {/* GATE TAB — Mechanical filters */}
        {activeTab === "gate" && (
          <div className="ctrl-section-group">
            <div className="ctrl-section">
              <label className="ctrl-label">Post type</label>
              <div className="ctrl-pill-group">
                {(["all", "top_level", "replies"] as const).map((t) => (
                  <button
                    key={t}
                    className={`ctrl-pill ${mech.post_type === t ? "active" : ""}`}
                    onClick={() => updateMech({ post_type: t })}
                  >
                    {t === "all" ? "All" : t === "top_level" ? "Original" : "Replies"}
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
                  label="No media posts"
                  checked={mech.exclude_media}
                  onChange={(v) => updateMech({ exclude_media: v, require_media: false })}
                />
                <Toggle
                  label="No link posts"
                  checked={mech.exclude_links}
                  onChange={(v) => updateMech({ exclude_links: v, require_link: false })}
                />
              </div>
            </div>

            <div className="ctrl-section">
              <label className="ctrl-label">Length</label>
              <div className="ctrl-inline-inputs">
                <div className="ctrl-mini-field">
                  <span>Min</span>
                  <input
                    type="number"
                    value={mech.min_length}
                    min={0}
                    onChange={(e) => updateMech({ min_length: parseInt(e.target.value) || 0 })}
                  />
                </div>
                <div className="ctrl-mini-field">
                  <span>Max</span>
                  <input
                    type="number"
                    value={mech.max_length}
                    min={0}
                    placeholder="∞"
                    onChange={(e) => updateMech({ max_length: parseInt(e.target.value) || 0 })}
                  />
                </div>
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

            <div className="ctrl-section">
              <label className="ctrl-label">Hashtags</label>
              <TagInput
                tags={mech.hashtag_include}
                placeholder="Include..."
                color="aurora"
                onAdd={(v) => updateMechList("hashtag_include", v, "add")}
                onRemove={(v) => updateMechList("hashtag_include", v, "remove")}
              />
              <TagInput
                tags={mech.hashtag_exclude}
                placeholder="Exclude..."
                color="rose"
                onAdd={(v) => updateMechList("hashtag_exclude", v, "add")}
                onRemove={(v) => updateMechList("hashtag_exclude", v, "remove")}
              />
            </div>

            <div className="ctrl-section">
              <label className="ctrl-label">Rate limit</label>
              <div className="ctrl-mini-field">
                <span>Posts per author/hr</span>
                <input
                  type="number"
                  value={mech.author_max_per_hour}
                  min={0}
                  placeholder="∞"
                  onChange={(e) =>
                    updateMech({ author_max_per_hour: parseInt(e.target.value) || 0 })
                  }
                />
              </div>
            </div>
          </div>
        )}

        {/* TUNE TAB — Threshold & strictness */}
        {activeTab === "tune" && (
          <div className="ctrl-section-group">
            <div className="ctrl-section">
              <label className="ctrl-label">
                Similarity threshold
                <span className="ctrl-label-value">{sem.embedding_threshold.toFixed(2)}</span>
              </label>
              <input
                type="range"
                className="ctrl-slider"
                min={0.1}
                max={0.9}
                step={0.05}
                value={sem.embedding_threshold}
                onChange={(e) =>
                  updateSem({ embedding_threshold: parseFloat(e.target.value) })
                }
              />
              <div className="ctrl-slider-labels">
                <span>More posts</span>
                <span>Higher quality</span>
              </div>
            </div>

            <div className="ctrl-section">
              <label className="ctrl-label">Judge strictness</label>
              <div className="ctrl-pill-group">
                {(["lenient", "moderate", "strict"] as const).map((s) => (
                  <button
                    key={s}
                    className={`ctrl-pill ${sem.judge_strictness === s ? "active" : ""}`}
                    onClick={() => updateSem({ judge_strictness: s })}
                  >
                    {s.charAt(0).toUpperCase() + s.slice(1)}
                  </button>
                ))}
              </div>
            </div>

            <div className="ctrl-section">
              <Toggle
                label="Enable LLM judge"
                checked={sem.judge_enabled}
                onChange={(v) => updateSem({ judge_enabled: v })}
              />
              <p className="ctrl-hint">
                When enabled, an AI reviews each post for relevance after embedding matching.
                Costs more but catches false positives.
              </p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// --- Sub-components ---

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
