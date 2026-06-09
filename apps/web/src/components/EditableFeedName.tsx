"use client";

import { useEffect, useRef, useState } from "react";
import { authedFetch } from "@/lib/authed-fetch";

const MAX_NAME_LEN = 80;

interface EditableFeedNameProps {
  feedId: string;
  name: string;
  onRenamed: (name: string) => void;
  variant: "sidebar" | "topbar";
  className?: string;
  /** sidebar: double-click; topbar: single click */
  editTrigger?: "click" | "dblclick";
}

export default function EditableFeedName({
  feedId,
  name,
  onRenamed,
  variant,
  className = "",
  editTrigger,
}: EditableFeedNameProps) {
  const trigger = editTrigger ?? (variant === "topbar" ? "click" : "dblclick");
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(name);
  const [saving, setSaving] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!editing) setDraft(name);
  }, [name, editing]);

  useEffect(() => {
    if (editing) inputRef.current?.focus();
  }, [editing]);

  function startEdit(e: React.MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    setDraft(name);
    setEditing(true);
  }

  async function commit() {
    const trimmed = draft.trim().slice(0, MAX_NAME_LEN);
    if (!trimmed || trimmed === name) {
      setDraft(name);
      setEditing(false);
      return;
    }
    setSaving(true);
    try {
      const res = await authedFetch("/api/feeds", {
        method: "PATCH",
        body: JSON.stringify({ id: Number(feedId), name: trimmed }),
      });
      if (res.ok) {
        onRenamed(trimmed);
        setEditing(false);
      } else {
        setDraft(name);
        setEditing(false);
      }
    } catch {
      setDraft(name);
      setEditing(false);
    } finally {
      setSaving(false);
    }
  }

  function cancel() {
    setDraft(name);
    setEditing(false);
  }

  if (editing) {
    return (
      <input
        ref={inputRef}
        type="text"
        className={`cur-feed-name-input cur-feed-name-input-${variant} ${className}`.trim()}
        value={draft}
        disabled={saving}
        maxLength={MAX_NAME_LEN}
        aria-label="Feed name"
        onChange={(e) => setDraft(e.target.value)}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            void commit();
          } else if (e.key === "Escape") {
            e.preventDefault();
            cancel();
          }
        }}
        onBlur={() => void commit()}
      />
    );
  }

  const title =
    trigger === "dblclick"
      ? "Double-click to rename"
      : "Click to rename";

  return (
    <span
      role="button"
      tabIndex={0}
      className={`cur-feed-name-editable cur-feed-name-editable-${variant} ${className}`.trim()}
      title={title}
      onClick={trigger === "click" ? startEdit : undefined}
      onDoubleClick={trigger === "dblclick" ? startEdit : undefined}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          setDraft(name);
          setEditing(true);
        }
      }}
    >
      {name}
    </span>
  );
}
