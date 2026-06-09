"use client";

import { createContext, useContext } from "react";
import type { UserProfile } from "@/lib/types";

export interface SavedFeed {
  id: string;
  name: string;
  color: string;
  subqueries: string[];
  createdAt: string;
}

export type MobileTab = "chat" | "feed" | "tune";

export type ViewMode = "card" | "embed";

export interface CuratorContextValue {
  profile: UserProfile;
  bskyOAuthReady: boolean;
  refreshProfile: () => Promise<void>;
  feeds: SavedFeed[];
  reloadFeeds: () => Promise<void>;
  activePostCount: number;
  setActivePostCount: (n: number) => void;
  mobileTab: MobileTab;
  setMobileTab: (t: MobileTab) => void;
  optionsUnread: boolean;
  setOptionsUnread: (b: boolean) => void;
  // Display settings, surfaced in the top-bar settings dialog and consumed by
  // the posts pane in CuratorWorkbench.
  viewMode: ViewMode;
  setViewMode: (m: ViewMode) => void;
  showDebug: boolean;
  setShowDebug: (b: boolean) => void;
  hideUnavailable: boolean;
  setHideUnavailable: (b: boolean) => void;
  // Count of posts the Bluesky availability probe flagged as unavailable,
  // mirrored up from the workbench so the settings dialog can show it.
  unavailableCount: number;
  setUnavailableCount: (n: number) => void;
  openPublish: () => void;
}

const CuratorContext = createContext<CuratorContextValue | null>(null);

export const CuratorProvider = CuratorContext.Provider;

export function useCurator(): CuratorContextValue {
  const v = useContext(CuratorContext);
  if (!v) throw new Error("useCurator must be used inside <CuratorProvider>");
  return v;
}

export function feedIsComplete(feed: { subqueries: string[] }): boolean {
  return (feed.subqueries?.length ?? 0) > 0;
}
