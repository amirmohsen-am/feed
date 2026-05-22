"use client";

/**
 * /introspect — splash page. Just an input for a Bluesky handle; submission
 * routes to /introspect/<handle> where the dashboard lives.
 */

import { useState } from "react";
import { useRouter } from "next/navigation";

export default function IntrospectSplash() {
  const router = useRouter();
  const [handleInput, setHandleInput] = useState("");

  return (
    <main className="min-h-screen bg-[#fafafa] text-[#1a1a1a]">
      <div className="mx-auto max-w-2xl px-6 py-24">
        <h1 className="text-4xl font-serif tracking-tight mb-3">introspect</h1>
        <p className="text-[#666] mb-8 leading-relaxed">
          A natural-language self-portrait built from your Bluesky engagements
          — likes, reposts, quotes, posts, and replies. Public handles only;
          no sign-in.
        </p>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            const h = handleInput.replace(/^@/, "").trim().toLowerCase();
            if (!h) return;
            router.push(`/introspect/${encodeURIComponent(h)}`);
          }}
          className="flex gap-2"
        >
          <input
            type="text"
            value={handleInput}
            onChange={(e) => setHandleInput(e.target.value)}
            placeholder="jay.bsky.team"
            className="flex-1 border border-[#ddd] rounded px-3 py-2 bg-white focus:outline-none focus:border-[#1a1a1a]"
            autoFocus
          />
          <button
            type="submit"
            disabled={!handleInput.trim()}
            className="px-4 py-2 bg-[#1a1a1a] text-white rounded disabled:opacity-50"
          >
            Introspect
          </button>
        </form>
      </div>
    </main>
  );
}
