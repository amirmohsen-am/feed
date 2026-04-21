"use client";

import { useState, useEffect } from "react";

interface Post {
  uri: string;
  author_did: string;
  text: string;
  score: number;
  indexed_at: string;
}

interface PreviewData {
  total_stored: number;
  posts: Post[];
}

export default function Preview() {
  const [data, setData] = useState<PreviewData | null>(null);
  const [loading, setLoading] = useState(true);

  async function refresh() {
    setLoading(true);
    const res = await fetch("/api/feed-preview");
    setData(await res.json());
    setLoading(false);
  }

  useEffect(() => {
    refresh();
    const interval = setInterval(refresh, 5000);
    return () => clearInterval(interval);
  }, []);

  return (
    <div className="min-h-screen bg-gray-950 text-gray-100 p-8">
      <div className="max-w-2xl mx-auto">
        <div className="flex items-center justify-between mb-6">
          <div>
            <h1 className="text-xl font-semibold">Feed Preview</h1>
            <p className="text-sm text-gray-500">Auto-refreshes every 5s</p>
          </div>
          <div className="text-right">
            <div className="text-2xl font-bold text-blue-400">
              {data?.total_stored ?? 0}
            </div>
            <div className="text-xs text-gray-500">posts stored</div>
          </div>
        </div>

        {loading && !data && (
          <p className="text-gray-500">Loading...</p>
        )}

        {data?.posts.length === 0 && (
          <div className="text-center py-20">
            <p className="text-gray-400 text-lg mb-2">No posts yet</p>
            <p className="text-gray-600 text-sm max-w-md mx-auto">
              The firehose worker is running and filtering posts against your
              preferences. Posts matching your criteria will appear here.
              Niche topics may take a while.
            </p>
            <div className="mt-4 flex justify-center">
              <div className="w-2 h-2 bg-green-500 rounded-full animate-pulse" />
              <span className="ml-2 text-xs text-green-400">Listening to firehose...</span>
            </div>
          </div>
        )}

        <div className="space-y-3">
          {data?.posts.map((post) => (
            <div
              key={post.uri}
              className="bg-gray-900 border border-gray-800 rounded-xl p-4"
            >
              <div className="flex items-center justify-between mb-2">
                <span className="text-xs text-gray-500 font-mono">
                  {post.author_did.slice(0, 24)}...
                </span>
                <span
                  className={`text-xs font-medium px-2 py-0.5 rounded ${
                    post.score >= 0.7
                      ? "bg-green-500/20 text-green-300"
                      : post.score >= 0.5
                        ? "bg-yellow-500/20 text-yellow-300"
                        : "bg-gray-700 text-gray-400"
                  }`}
                >
                  {post.score.toFixed(2)}
                </span>
              </div>
              <p className="text-sm leading-relaxed">{post.text}</p>
              <div className="mt-2 text-xs text-gray-600">{post.indexed_at}</div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
