"use client";

import { createContext, useContext } from "react";
import type { UserProfile } from "@/lib/types";
import type { PipelineStage } from "@/components/PipelineLoader";

export interface SavedFeed {
  id: string;
  name: string;
  color: string;
  subqueries: string[];
  createdAt: string;
  isHome: boolean;
  parentFeedId: string | null;
}

export type MobileTab = "chat" | "feed";

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
  openTune: () => void;
  registerOpenTune: (fn: () => void) => void;
  pipelineStage: PipelineStage;
  setPipelineStage: (s: PipelineStage) => void;
  pipelineCandidates: number | undefined;
  setPipelineCandidates: (n: number | undefined) => void;
  pipelineHits: number | undefined;
  setPipelineHits: (n: number | undefined) => void;
  pipelineImages: number | undefined;
  setPipelineImages: (n: number | undefined) => void;
  pipelineModel: string | undefined;
  setPipelineModel: (s: string | undefined) => void;
  pipelineThinkingEnabled: boolean | undefined;
  setPipelineThinkingEnabled: (b: boolean | undefined) => void;
  pipelineSeenFiltered: number | undefined;
  setPipelineSeenFiltered: (n: number | undefined) => void;
  /** When set, overrides the feed name shown in the topbar (e.g. branch overlay). */
  branchOverlayName: string | null;
  setBranchOverlayName: (name: string | null) => void;
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
