"use client";

import { useParams } from "next/navigation";
import CuratorWorkbench from "./CuratorWorkbench";

export default function FeedPage() {
  const params = useParams<{ feedId: string }>();
  const feedId = params?.feedId;
  if (!feedId) return null;
  // Keying off feedId forces a clean remount when the route param changes,
  // which is the whole point of Option 2 — every piece of per-feed state
  // resets atomically with no chance of a stale fetch landing on the new feed.
  return <CuratorWorkbench key={feedId} feedId={parseInt(feedId, 10)} />;
}
