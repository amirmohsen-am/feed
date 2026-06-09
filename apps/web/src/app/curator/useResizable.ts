"use client";

import { useState, useEffect, useRef, useCallback } from "react";

function readStoredWidth(key: string, fallback: number, min: number, max: number): number {
  if (typeof window === "undefined") return fallback;
  const raw = window.localStorage.getItem(key);
  if (!raw) return fallback;
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

export function useResizable(
  key: string,
  initial: number,
  min: number,
  max: number,
  direction: "left" | "right"
): [number, (e: React.PointerEvent<HTMLDivElement>) => void] {
  // Always start from `initial` so SSR and the first client render match.
  // Restore the persisted width after mount (see React hydration docs).
  const [width, setWidth] = useState<number>(initial);
  const draggingRef = useRef<{ startX: number; startW: number } | null>(null);

  useEffect(() => {
    setWidth(readStoredWidth(key, initial, min, max));
  }, [key, initial, min, max]);

  useEffect(() => {
    function onMove(e: PointerEvent) {
      const d = draggingRef.current;
      if (!d) return;
      const dx = e.clientX - d.startX;
      const next = direction === "left" ? d.startW + dx : d.startW - dx;
      const clamped = Math.min(max, Math.max(min, next));
      setWidth(clamped);
    }
    function onUp() {
      if (!draggingRef.current) return;
      draggingRef.current = null;
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      try { window.localStorage.setItem(key, String(width)); } catch { /* ignore */ }
    }
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
  }, [key, min, max, direction, width]);

  const startDrag = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    draggingRef.current = { startX: e.clientX, startW: width };
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
  }, [width]);

  return [width, startDrag];
}
