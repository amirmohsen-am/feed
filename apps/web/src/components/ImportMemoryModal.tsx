"use client";

import { useState, useRef } from "react";

interface Feed {
  id: number;
  name: string;
  subqueries: string[];
}

interface ImportMemoryModalProps {
  onClose: () => void;
  onImported: (feed: Feed) => void;
}

const overlay: React.CSSProperties = {
  position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)",
  backdropFilter: "blur(8px)", display: "flex", alignItems: "center",
  justifyContent: "center", zIndex: 100,
};
const modal: React.CSSProperties = {
  background: "var(--midnight, #0a1a14)", border: "1px solid var(--hair, #1a2e24)",
  borderRadius: 12, width: "100%", maxWidth: 480, overflow: "hidden",
  fontFamily: "var(--rf-body, system-ui)", color: "var(--cream, #f3ecdd)",
};
const header: React.CSSProperties = {
  display: "flex", alignItems: "center", justifyContent: "space-between",
  padding: "16px 24px", borderBottom: "1px solid var(--hair, #1a2e24)",
};
const body: React.CSSProperties = { padding: "20px 24px" };
const label: React.CSSProperties = {
  fontFamily: "var(--rf-display, Georgia)", fontSize: 15, fontWeight: 400,
};
const closeBtn: React.CSSProperties = {
  background: "none", border: "none", color: "var(--parchment-dim, #8a9a90)",
  fontSize: 20, cursor: "pointer",
};
const navBtn: React.CSSProperties = {
  padding: "10px 16px", borderRadius: 8,
  border: "none", cursor: "pointer", fontSize: 13,
  fontFamily: "var(--rf-body, system-ui)", transition: "all 0.2s",
};

export default function ImportMemoryModal({
  onClose,
  onImported,
}: ImportMemoryModalProps) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [pasteText, setPasteText] = useState("");
  const fileInputRef = useRef<HTMLInputElement>(null);

  async function handleImport(text: string) {
    if (!text.trim()) { setError("No content to import"); return; }
    setLoading(true);
    setError("");
    try {
      const res = await fetch("/api/import-memory", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ memoryText: text }),
      });
      const data = await res.json();
      if (data.error) setError(data.error);
      else onImported(data.feed);
    } catch {
      setError("Something went wrong. Try again.");
    } finally {
      setLoading(false);
    }
  }

  async function handleFileUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    const text = await file.text();
    try {
      const json = JSON.parse(text);
      if (Array.isArray(json)) {
        await handleImport(json.map((m: { content?: string }) => m.content || JSON.stringify(m)).join("\n"));
        return;
      }
      if (json.memories) {
        await handleImport(json.memories.map((m: { content?: string }) => m.content || JSON.stringify(m)).join("\n"));
        return;
      }
      await handleImport(text);
    } catch {
      await handleImport(text);
    }
  }

  return (
    <div style={overlay} onClick={onClose}>
      <div style={modal} onClick={(e) => e.stopPropagation()}>
        <div style={header}>
          <span style={label}>Import AI Memory</span>
          <button style={closeBtn} onClick={onClose}>&times;</button>
        </div>

        <div style={body}>
          <p style={{ fontSize: 13, color: "var(--parchment-dim)", marginBottom: 12 }}>
            Paste memory from ChatGPT (Settings → Personalization → Memory) or Claude
            (Settings → Memory), or upload a JSON/text export.
          </p>
          <textarea
            value={pasteText}
            onChange={(e) => setPasteText(e.target.value)}
            placeholder="Paste your AI memories here..."
            rows={8}
            style={{
              width: "100%", background: "var(--void, #060f0b)",
              border: "1px solid var(--hair-strong, #2a3e34)", borderRadius: 8,
              padding: "12px 14px", fontSize: 13, color: "var(--cream)",
              fontFamily: "var(--rf-body)", resize: "none",
              outline: "none",
            }}
          />
          <div style={{ display: "flex", alignItems: "center", gap: 12, marginTop: 12 }}>
            <button
              onClick={() => handleImport(pasteText)}
              disabled={loading || !pasteText.trim()}
              style={{
                ...navBtn, flex: 1, background: "var(--aurora, #7dcba5)",
                color: "var(--void, #060f0b)", fontWeight: 500,
                opacity: loading || !pasteText.trim() ? 0.3 : 1,
              }}
            >
              {loading ? "Generating feed..." : "Generate feed"}
            </button>
            <span style={{ fontSize: 11, color: "var(--parchment-dim)" }}>or</span>
            <button
              onClick={() => fileInputRef.current?.click()}
              disabled={loading}
              style={{
                ...navBtn, background: "var(--hair-strong, #2a3e34)",
                color: "var(--cream)", opacity: loading ? 0.3 : 1,
              }}
            >
              Upload file
            </button>
            <input
              ref={fileInputRef}
              type="file"
              accept=".json,.txt,.md"
              onChange={handleFileUpload}
              style={{ display: "none" }}
            />
          </div>
          {error && (
            <p style={{ fontSize: 12, color: "var(--rose, #e09575)", marginTop: 10 }}>{error}</p>
          )}
        </div>
      </div>
    </div>
  );
}
