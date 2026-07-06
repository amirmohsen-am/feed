"use client";

import { createContext, useContext } from "react";
import type { UserProfile } from "@/lib/types";
import type { GateStatus } from "@/lib/account-gate";
import type { PendingAction } from "@/lib/pending-action";
import type { ConnectVariant } from "@/components/ConnectBlueskyModal";

export interface OpenConnectModalOptions {
  variant?: ConnectVariant;
  /** Contextual copy line shown in the modal, e.g. "Connect to like posts from here." */
  reason?: string;
  /** Action to auto-resume after the OAuth round trip. */
  pendingAction?: PendingAction | null;
}

export interface SavedFeed {
  id: string;
  name: string;
  subqueries: string[];
  createdAt: string;
  isHome: boolean;
  parentFeedId: string | null;
}

export type MobileTab = "chat" | "feed";

export type ViewMode = "card" | "embed";

interface CuratorContextValue {
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
  // Per-user preference (users.seen_filter_enabled), persisted server-side.
  // Drives whether the feed hides posts you've already seen + whether the
  // workbench records on-screen impressions. Default on.
  hideSeen: boolean;
  setHideSeen: (b: boolean) => void;
  // Count of posts the Bluesky availability probe flagged as unavailable,
  // mirrored up from the workbench so the settings dialog can show it.
  unavailableCount: number;
  setUnavailableCount: (n: number) => void;
  sidebarOpen: boolean;
  setSidebarOpen: (b: boolean) => void;
  /** True once the feed's first load has settled — gates topbar chrome to avoid the flash. */
  configReady: boolean;
  setConfigReady: (b: boolean) => void;
  /** True while the page load's FIRST onboarding surface is visible — hides
      non-essential chrome. Later onboardings (new topics) keep the topbar. */
  showOnboarding: boolean;
  setShowOnboarding: (b: boolean) => void;
  openPublish: () => void;
  openTune: () => void;
  registerOpenTune: (fn: () => void) => void;
  // Account gate (anonymous grace period → nudges → wall). Null until the
  // boot /api/user fetch resolves; "linked" users never see nudges or wall.
  gate: GateStatus | null;
  /** Open the connect/create Bluesky modal (chooser page). */
  openConnectModal: (opts?: OpenConnectModalOptions) => void;
  // Action stashed before an OAuth redirect, replayed once after the user
  // returns connected. Null when there is nothing to resume.
  resumeAction: PendingAction | null;
  clearResumeAction: () => void;
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
