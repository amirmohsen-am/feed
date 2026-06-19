"use client";

import { Suspense, useEffect, useRef } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { authedFetch } from "@/lib/authed-fetch";
import { useCurator } from "./curatorContext";

// Landing route for /curator. The layout has already gated on auth/onboarding,
// so by the time this runs we know we have a profile. We pick the user's most
// recent feed and redirect there. If they have none, we create one. The user
// effectively always lives at /curator/[id].
//
// Two query params modify behavior:
//   ?new=1            force-create a fresh feed even when feeds already exist
//                     (used by suggestion cards in /introspect)
//   ?prompt=<text>    forwarded to the workbench so it can seed the chat input
export default function CuratorLanding() {
  return (
    <Suspense fallback={null}>
      <CuratorLandingInner />
    </Suspense>
  );
}

function CuratorLandingInner() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { feeds, reloadFeeds } = useCurator();
  const ranRef = useRef(false);

  useEffect(() => {
    if (ranRef.current) return;
    ranRef.current = true;

    const forceNew = searchParams.get("new") === "1";
    const promptParam = searchParams.get("prompt");
    const promptSuffix = promptParam
      ? `?prompt=${encodeURIComponent(promptParam)}`
      : "";

    (async () => {
      try {
        // Always go through /api/feeds which ensures the home feed exists.
        const res = await authedFetch("/api/feeds");
        const data = await res.json();
        const list: { id: number; is_home?: boolean }[] = data.feeds || [];

        if (forceNew) {
          // ?new=1: create a fresh regular feed and land there.
          const createRes = await authedFetch("/api/feeds", {
            method: "POST",
            body: JSON.stringify({ name: "Untitled" }),
          });
          const created = await createRes.json();
          const id = created.feed?.id ?? created.id;
          if (id != null) {
            await reloadFeeds();
            router.replace(`/curator/${id}${promptSuffix}`);
          }
          return;
        }

        // Default: land on the home feed (always first in the list after ensureHomeFeed).
        const home = list.find((f) => f.is_home) ?? list[0];
        if (home) {
          router.replace(`/curator/${home.id}${promptSuffix}`);
        }
      } catch {
        /* ignore — user will see the spinner and can retry */
      }
    })();
  }, [router, reloadFeeds, feeds, searchParams]);

  return (
    <div
      style={{
        flex: 1,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <div className="cur-dots"><span /><span /><span /></div>
    </div>
  );
}
