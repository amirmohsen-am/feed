"use client";

import { createContext, useContext } from "react";
import type { UserProfile } from "@/components/Onboarding";

export interface FeedCriteria {
  topics: string[];
  keywords: string[];
  exclude_topics: string[];
  exclude_keywords: string[];
  vibes: string;
}

export interface SavedFeed {
  id: string;
  name: string;
  color: string;
  criteria: FeedCriteria;
  createdAt: string;
}

export type MobileTab = "chat" | "feed" | "tune";

export interface CuratorContextValue {
  profile: UserProfile;
  feeds: SavedFeed[];
  reloadFeeds: () => Promise<void>;
  activePostCount: number;
  setActivePostCount: (n: number) => void;
  mobileTab: MobileTab;
  setMobileTab: (t: MobileTab) => void;
  optionsUnread: boolean;
  setOptionsUnread: (b: boolean) => void;
}

const CuratorContext = createContext<CuratorContextValue | null>(null);

export const CuratorProvider = CuratorContext.Provider;

export function useCurator(): CuratorContextValue {
  const v = useContext(CuratorContext);
  if (!v) throw new Error("useCurator must be used inside <CuratorProvider>");
  return v;
}

export function feedIsComplete(feed: { criteria: FeedCriteria }): boolean {
  return (
    (feed.criteria.topics?.length ?? 0) > 0 ||
    (feed.criteria.keywords?.length ?? 0) > 0
  );
}
