"use client";

import { useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import { authedFetch } from "@/lib/authed-fetch";
import { useCurator } from "./curatorContext";

// Landing route for /curator. The layout has already gated on auth/onboarding,
// so by the time this runs we know we have a profile. We pick the user's most
// recent feed and redirect there. If they have none, we create one. The user
// effectively always lives at /curator/[id].
export default function CuratorLanding() {
  const router = useRouter();
  const { feeds, reloadFeeds } = useCurator();
  const ranRef = useRef(false);

  useEffect(() => {
    if (ranRef.current) return;
    ranRef.current = true;

    (async () => {
      try {
        // Layout fires reloadFeeds() on mount too, but we don't want to race
        // it — go straight to the source of truth.
        const res = await authedFetch("/api/feeds");
        const data = await res.json();
        const list: { id: number }[] = data.feeds || [];
        if (list.length > 0) {
          router.replace(`/curator/${list[0].id}`);
          return;
        }
        // No feeds — create one and land there.
        const createRes = await authedFetch("/api/feeds", {
          method: "POST",
          body: JSON.stringify({ name: "Untitled" }),
        });
        const created = await createRes.json();
        const id = created.feed?.id ?? created.id;
        if (id != null) {
          await reloadFeeds();
          router.replace(`/curator/${id}`);
        }
      } catch {
        /* ignore — user will see the spinner and can retry */
      }
    })();
  }, [router, reloadFeeds, feeds]);

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
