"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { useRouter } from "next/navigation";
import { Dialog as DialogPrimitive } from "@base-ui/react/dialog";
import { feedIsComplete, type SavedFeed } from "@/app/curator/curatorContext";

interface FeedSearchProps {
  feeds: SavedFeed[];
  activeFeedId: string | null;
  onNewFeed: () => void;
}

export default function FeedSearch({ feeds, activeFeedId, onNewFeed }: FeedSearchProps) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const filtered = feeds.filter((f) =>
    f.name.toLowerCase().includes(query.toLowerCase()) ||
    f.subqueries.some((sq) => sq.toLowerCase().includes(query.toLowerCase()))
  );

  // +1 for the "New feed" action at the end
  const totalItems = filtered.length + 1;

  const resetAndClose = useCallback(() => {
    setOpen(false);
    setQuery("");
    setSelectedIndex(0);
  }, []);

  // Cmd+K / Ctrl+K to open
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        setOpen((prev) => !prev);
        if (!open) {
          setQuery("");
          setSelectedIndex(0);
        }
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open]);

  // Focus input when opened
  useEffect(() => {
    if (open) {
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [open]);

  // Reset selection when query changes
  useEffect(() => {
    setSelectedIndex(0);
  }, [query]);

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setSelectedIndex((i) => (i + 1) % totalItems);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSelectedIndex((i) => (i - 1 + totalItems) % totalItems);
    } else if (e.key === "Enter") {
      e.preventDefault();
      selectItem(selectedIndex);
    } else if (e.key === "Escape") {
      resetAndClose();
    }
  }

  function selectItem(index: number) {
    if (index < filtered.length) {
      const feed = filtered[index];
      router.push(`/curator/${feed.id}`);
      resetAndClose();
    } else {
      // "New feed" action
      onNewFeed();
      resetAndClose();
    }
  }

  return (
    <DialogPrimitive.Root open={open} onOpenChange={setOpen}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Backdrop className="cmdk-backdrop" />
        <DialogPrimitive.Popup className="cmdk-dialog">
          <div className="cmdk-input-wrap">
            <svg className="cmdk-search-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="11" cy="11" r="8" />
              <line x1="21" y1="21" x2="16.65" y2="16.65" />
            </svg>
            <input
              ref={inputRef}
              className="cmdk-input"
              placeholder="Search feeds..."
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={handleKeyDown}
            />
            <kbd className="cmdk-kbd">esc</kbd>
          </div>

          <div className="cmdk-list">
            {filtered.length === 0 && query && (
              <div className="cmdk-empty">No feeds matching &ldquo;{query}&rdquo;</div>
            )}

            {filtered.map((feed, i) => {
              const isActive = feed.id === activeFeedId;
              const isComplete = feedIsComplete(feed);
              return (
                <button
                  key={feed.id}
                  className={`cmdk-item${selectedIndex === i ? " selected" : ""}`}
                  onMouseEnter={() => setSelectedIndex(i)}
                  onClick={() => selectItem(i)}
                  data-active={isActive || undefined}
                >
                  <div className="cmdk-item-text">
                    <span className="cmdk-item-name">{feed.name}</span>
                    {feed.subqueries.length > 0 && (
                      <span className="cmdk-item-sub">
                        {feed.subqueries.slice(0, 3).join(" · ")}
                      </span>
                    )}
                  </div>
                  <span className="cmdk-item-meta">
                    {isActive
                      ? "current"
                      : !isComplete
                      ? "drafting"
                      : new Date(feed.createdAt).toLocaleDateString()}
                  </span>
                </button>
              );
            })}

            <div className="cmdk-separator" />

            <button
              className={`cmdk-item cmdk-action${selectedIndex === filtered.length ? " selected" : ""}`}
              onMouseEnter={() => setSelectedIndex(filtered.length)}
              onClick={() => selectItem(filtered.length)}
            >
              <span className="cmdk-action-icon">+</span>
              <span className="cmdk-item-name">New feed</span>
            </button>
          </div>
        </DialogPrimitive.Popup>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
