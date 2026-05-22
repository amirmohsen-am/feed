"use client";

import { createContext, useContext } from "react";
import type { UserProfile } from "@/components/Onboarding";

export interface SavedFeed {
  id: string;
  name: string;
  color: string;
  subqueries: string[];
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

export function feedIsComplete(feed: { subqueries: string[] }): boolean {
  return (feed.subqueries?.length ?? 0) > 0;
}
