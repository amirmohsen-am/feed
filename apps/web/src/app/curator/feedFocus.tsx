"use client";

import { createContext, useContext } from "react";
import type { FeedViewHandle } from "./[feedId]/FeedView";

// A "leaf feed" focus stack for the recursive FeedView tree. Every FeedView (the
// root and each inline nested branch) registers its imperative handle on mount;
// because a branch only mounts once its parent commits, mount order == nesting
// depth, so the top of the stack is always the feed the user is currently looking
// at. User-initiated refresh (mobile pull-to-refresh) targets that leaf instead
// of always hitting the root.
export interface FeedFocusValue {
  /** Push this feed's handle onto the leaf stack; returns an unregister fn. */
  registerLeaf: (handle: FeedViewHandle) => () => void;
}

const FeedFocusContext = createContext<FeedFocusValue | null>(null);

export const FeedFocusProvider = FeedFocusContext.Provider;

export function useFeedFocus(): FeedFocusValue {
  const v = useContext(FeedFocusContext);
  if (!v) throw new Error("useFeedFocus must be used inside <FeedFocusProvider>");
  return v;
}
