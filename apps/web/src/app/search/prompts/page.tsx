"use client";

import { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import "../search.css";
import { authedFetch } from "@/lib/authed-fetch";

interface PromptListItem {
  id: string;
  name: string;
  current_version: number | null;
  current_system_prompt: string | null;
}

interface PromptDetail {
  id: string;
  name: string;
  current_version: number | null;
  current_version_id: string | null;
  current_system_prompt: string | null;
  versions: {
    id: string;
    version: number;
    system_prompt: string;
    created_at: string;
  }[];
}

const DEFAULT_PROMPT = `You are a discerning editor selecting Bluesky posts a thoughtful reader would actually save.

Given a query and a list of candidate posts retrieved by semantic search, return only the items that match the query's intent AND clear an editorial bar — concrete, specific, and worth a reader's attention.

Reject:
- pure topical matches without insight
- partisan dunks and outrage bait
- vague generalities and hot takes

Prefer:
- specific anecdotes that imply a general claim
- arguments that name and refine a dichotomy
- posts that would change a thoughtful reader's mind, even slightly`;

export default function PromptsPage() {
  return (
    <Suspense fallback={null}>
      <PromptsPageInner />
    </Suspense>
  );
}

function PromptsPageInner() {
  const searchParams = useSearchParams();
  const initialId = searchParams.get("id");

  const [prompts, setPrompts] = useState<PromptListItem[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(initialId);
  const [detail, setDetail] = useState<PromptDetail | null>(null);
  const [name, setName] = useState("");
  const [systemPrompt, setSystemPrompt] = useState("");
  const [savingNew, setSavingNew] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reloadList = useCallback(async () => {
    try {
      const res = await authedFetch("/api/rerank-prompts");
      if (!res.ok) return;
      const data = await res.json();
      const list: PromptListItem[] = data.prompts || [];
      setPrompts(list);
      if (!selectedId && list.length > 0) setSelectedId(list[0].id);
    } catch {
      /* ignore */
    }
  }, [selectedId]);

  useEffect(() => {
    reloadList();
  }, [reloadList]);

  useEffect(() => {
    if (!selectedId) {
      setDetail(null);
      setName("");
      setSystemPrompt("");
      return;
    }
    (async () => {
      try {
        const res = await authedFetch(`/api/rerank-prompts/${selectedId}`);
        if (!res.ok) {
          setDetail(null);
          return;
        }
        const data: PromptDetail = await res.json();
        setDetail(data);
        setName(data.name);
        setSystemPrompt(data.current_system_prompt ?? "");
      } catch {
        /* ignore */
      }
    })();
  }, [selectedId]);

  const dirty = useMemo(
    () => detail !== null && systemPrompt !== (detail.current_system_prompt ?? ""),
    [detail, systemPrompt]
  );
  const nameDirty = useMemo(
    () => detail !== null && name.trim() !== detail.name && name.trim() !== "",
    [detail, name]
  );

  async function handleNewPrompt() {
    const newName = window.prompt("Name for new prompt:");
    if (!newName?.trim()) return;
    try {
      const res = await authedFetch("/api/rerank-prompts", {
        method: "POST",
        body: JSON.stringify({
          name: newName.trim(),
          system_prompt: DEFAULT_PROMPT,
        }),
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        throw new Error(d.error || `HTTP ${res.status}`);
      }
      const created: PromptListItem = await res.json();
      setSelectedId(created.id);
      await reloadList();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  async function handleSaveVersion() {
    if (!detail) return;
    setSavingNew(true);
    setError(null);
    try {
      const res = await authedFetch(
        `/api/rerank-prompts/${detail.id}/versions`,
        {
          method: "POST",
          body: JSON.stringify({ system_prompt: systemPrompt }),
        }
      );
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        throw new Error(d.error || `HTTP ${res.status}`);
      }
      // refresh detail to pick up the new version + current pointer
      const detRes = await authedFetch(`/api/rerank-prompts/${detail.id}`);
      if (detRes.ok) setDetail(await detRes.json());
      await reloadList();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSavingNew(false);
    }
  }

  async function handleRename() {
    if (!detail) return;
    setRenaming(true);
    setError(null);
    try {
      const res = await authedFetch(`/api/rerank-prompts/${detail.id}`, {
        method: "PATCH",
        body: JSON.stringify({ name: name.trim() }),
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        throw new Error(d.error || `HTTP ${res.status}`);
      }
      setDetail({ ...detail, name: name.trim() });
      await reloadList();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setRenaming(false);
    }
  }

  async function handleDelete() {
    if (!detail) return;
    if (!window.confirm(`Delete "${detail.name}"? This can't be undone.`)) return;
    setError(null);
    try {
      const res = await authedFetch(`/api/rerank-prompts/${detail.id}`, {
        method: "DELETE",
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        throw new Error(d.error || `HTTP ${res.status}`);
      }
      setSelectedId(null);
      setDetail(null);
      await reloadList();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  async function handleActivate(versionId: string) {
    if (!detail) return;
    setError(null);
    try {
      const res = await authedFetch(
        `/api/rerank-prompts/${detail.id}/activate`,
        {
          method: "POST",
          body: JSON.stringify({ version_id: versionId }),
        }
      );
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        throw new Error(d.error || `HTTP ${res.status}`);
      }
      const detRes = await authedFetch(`/api/rerank-prompts/${detail.id}`);
      if (detRes.ok) setDetail(await detRes.json());
      await reloadList();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  return (
    <div className="srch-prm-shell">
      <aside className="srch-prm-list">
        <div className="srch-rail-head">
          <Link href="/search">← Back to search</Link>
        </div>
        <div className="srch-section-label">Your prompts</div>
        {prompts.length === 0 && (
          <div style={{ fontSize: 12, color: "var(--ink-3)" }}>
            No prompts yet.
          </div>
        )}
        {prompts.map((p) => (
          <button
            key={p.id}
            className={`srch-prompt-item ${
              selectedId === p.id ? "active" : ""
            }`}
            onClick={() => setSelectedId(p.id)}
          >
            <span>{p.name}</span>
            <span className="tag">v{p.current_version ?? 1}</span>
          </button>
        ))}
        <button
          className="srch-link"
          onClick={handleNewPrompt}
          style={{ marginTop: 14 }}
        >
          + New prompt
        </button>
      </aside>

      <main className="srch-prm-editor">
        {detail ? (
          <>
            <h1>{detail.name}</h1>
            <div className="srch-prm-meta">
              version{" "}
              <span className="ver">v{detail.current_version ?? 1}</span> ·{" "}
              {detail.versions.length} total
            </div>

            {error && <div className="srch-error">{error}</div>}

            <div className="srch-prm-field">
              <label>Name</label>
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
              {nameDirty && (
                <div className="srch-prm-actions">
                  <button
                    className="srch-btn ghost"
                    onClick={handleRename}
                    disabled={renaming}
                  >
                    {renaming ? "Saving…" : "Save name"}
                  </button>
                </div>
              )}
            </div>

            <div className="srch-prm-field">
              <label>System prompt</label>
              <textarea
                value={systemPrompt}
                onChange={(e) => setSystemPrompt(e.target.value)}
                spellCheck={false}
              />
            </div>

            <div className="srch-prm-actions">
              <button
                className="srch-btn"
                onClick={handleSaveVersion}
                disabled={savingNew || !dirty || !systemPrompt.trim()}
              >
                {savingNew
                  ? "Saving…"
                  : dirty
                  ? "Save new version"
                  : "No changes"}
              </button>
              <button className="srch-btn danger" onClick={handleDelete}>
                Delete prompt
              </button>
            </div>

            {detail.versions.length > 1 && (
              <div className="srch-versions">
                <div className="srch-section-label">History</div>
                {detail.versions.map((v) => (
                  <div
                    key={v.id}
                    className={`srch-version-item ${
                      v.id === detail.current_version_id ? "current" : ""
                    }`}
                  >
                    <div>
                      <span className="ver">v{v.version}</span>{" "}
                      <span className="ts">
                        {new Date(v.created_at).toLocaleString()}
                      </span>
                    </div>
                    {v.id === detail.current_version_id ? (
                      <span
                        style={{
                          fontSize: 11,
                          color: "var(--aurora-deep)",
                          fontFamily: "var(--rf-mono)",
                        }}
                      >
                        active
                      </span>
                    ) : (
                      <button
                        className="srch-btn ghost"
                        onClick={() => handleActivate(v.id)}
                      >
                        Activate
                      </button>
                    )}
                  </div>
                ))}
              </div>
            )}
          </>
        ) : (
          <div className="srch-empty" style={{ marginTop: 80 }}>
            {prompts.length === 0
              ? "Create your first reranker prompt to get started."
              : "Pick a prompt from the left."}
          </div>
        )}
      </main>
    </div>
  );
}
