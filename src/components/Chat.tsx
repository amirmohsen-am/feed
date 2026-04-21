"use client";

import { useState, useEffect, useRef } from "react";

interface Message {
  role: "user" | "assistant";
  content: string;
}

interface FeedCriteria {
  topics: string[];
  keywords: string[];
  exclude_topics: string[];
  exclude_keywords: string[];
  vibes: string;
}

interface Preferences {
  description: string;
  criteria: FeedCriteria;
}

export default function Chat() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [preferences, setPreferences] = useState<Preferences | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    fetch("/api/chat")
      .then((r) => r.json())
      .then((data) => {
        setMessages(data.messages || []);
        setPreferences(data.preferences || null);
      });
  }, []);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  async function sendMessage(e: React.FormEvent) {
    e.preventDefault();
    if (!input.trim() || loading) return;

    const userMessage = input.trim();
    setInput("");
    setMessages((prev) => [...prev, { role: "user", content: userMessage }]);
    setLoading(true);

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: userMessage }),
      });
      const data = await res.json();
      setMessages(data.messages || []);
      if (data.preferences) setPreferences(data.preferences);
    } catch {
      setMessages((prev) => [
        ...prev,
        { role: "assistant", content: "Something went wrong. Try again." },
      ]);
    } finally {
      setLoading(false);
    }
  }

  async function resetChat() {
    await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reset: true }),
    });
    setMessages([]);
  }

  const hasCriteria =
    preferences?.criteria &&
    (preferences.criteria.topics.length > 0 ||
      preferences.criteria.keywords.length > 0);

  return (
    <div className="flex h-screen bg-gray-950 text-gray-100">
      {/* Sidebar - current preferences */}
      <div className="w-80 border-r border-gray-800 p-6 flex flex-col gap-4 overflow-y-auto">
        <h2 className="text-sm font-semibold text-gray-400 uppercase tracking-wider">
          Feed Preferences
        </h2>
        {hasCriteria ? (
          <div className="space-y-4">
            {preferences!.criteria.topics.length > 0 && (
              <div>
                <h3 className="text-xs font-medium text-gray-500 mb-1.5">
                  Topics
                </h3>
                <div className="flex flex-wrap gap-1.5">
                  {preferences!.criteria.topics.map((t) => (
                    <span
                      key={t}
                      className="px-2 py-0.5 bg-blue-500/20 text-blue-300 rounded text-xs"
                    >
                      {t}
                    </span>
                  ))}
                </div>
              </div>
            )}
            {preferences!.criteria.keywords.length > 0 && (
              <div>
                <h3 className="text-xs font-medium text-gray-500 mb-1.5">
                  Keywords
                </h3>
                <div className="flex flex-wrap gap-1.5">
                  {preferences!.criteria.keywords.map((k) => (
                    <span
                      key={k}
                      className="px-2 py-0.5 bg-green-500/20 text-green-300 rounded text-xs"
                    >
                      {k}
                    </span>
                  ))}
                </div>
              </div>
            )}
            {preferences!.criteria.exclude_topics.length > 0 && (
              <div>
                <h3 className="text-xs font-medium text-gray-500 mb-1.5">
                  Excluded
                </h3>
                <div className="flex flex-wrap gap-1.5">
                  {preferences!.criteria.exclude_topics.map((t) => (
                    <span
                      key={t}
                      className="px-2 py-0.5 bg-red-500/20 text-red-300 rounded text-xs"
                    >
                      {t}
                    </span>
                  ))}
                </div>
              </div>
            )}
            {preferences!.criteria.vibes && (
              <div>
                <h3 className="text-xs font-medium text-gray-500 mb-1.5">
                  Vibe
                </h3>
                <p className="text-sm text-gray-300">
                  {preferences!.criteria.vibes}
                </p>
              </div>
            )}
          </div>
        ) : (
          <p className="text-sm text-gray-500">
            No preferences set yet. Start chatting to curate your feed.
          </p>
        )}
        <button
          onClick={resetChat}
          className="mt-auto text-xs text-gray-500 hover:text-gray-300 transition-colors"
        >
          Reset conversation
        </button>
      </div>

      {/* Chat area */}
      <div className="flex-1 flex flex-col">
        <div className="border-b border-gray-800 px-6 py-4">
          <h1 className="text-lg font-semibold">Feed Curator</h1>
          <p className="text-sm text-gray-500">
            Describe what you want to see on your Bluesky feed
          </p>
        </div>

        <div className="flex-1 overflow-y-auto px-6 py-4 space-y-4">
          {messages.length === 0 && (
            <div className="flex items-center justify-center h-full">
              <div className="text-center max-w-md">
                <p className="text-gray-400 text-lg mb-2">
                  What do you want your Bluesky feed to look like?
                </p>
                <p className="text-gray-600 text-sm">
                  Tell me about topics, people, vibes, or things you want to
                  avoid. I&apos;ll set up your custom feed.
                </p>
              </div>
            </div>
          )}
          {messages.map((msg, i) => (
            <div
              key={i}
              className={`flex ${msg.role === "user" ? "justify-end" : "justify-start"}`}
            >
              <div
                className={`max-w-lg px-4 py-2.5 rounded-2xl text-sm leading-relaxed ${
                  msg.role === "user"
                    ? "bg-blue-600 text-white"
                    : "bg-gray-800 text-gray-200"
                }`}
              >
                {msg.content}
              </div>
            </div>
          ))}
          {loading && (
            <div className="flex justify-start">
              <div className="bg-gray-800 px-4 py-2.5 rounded-2xl">
                <div className="flex gap-1">
                  <span className="w-2 h-2 bg-gray-500 rounded-full animate-bounce" />
                  <span className="w-2 h-2 bg-gray-500 rounded-full animate-bounce [animation-delay:0.1s]" />
                  <span className="w-2 h-2 bg-gray-500 rounded-full animate-bounce [animation-delay:0.2s]" />
                </div>
              </div>
            </div>
          )}
          <div ref={messagesEndRef} />
        </div>

        <form
          onSubmit={sendMessage}
          className="border-t border-gray-800 px-6 py-4"
        >
          <div className="flex gap-3">
            <input
              type="text"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="Describe your ideal feed..."
              className="flex-1 bg-gray-800 border border-gray-700 rounded-xl px-4 py-3 text-sm
                         placeholder-gray-500 focus:outline-none focus:border-blue-500 transition-colors"
              disabled={loading}
            />
            <button
              type="submit"
              disabled={loading || !input.trim()}
              className="px-5 py-3 bg-blue-600 hover:bg-blue-500 disabled:opacity-40
                         rounded-xl text-sm font-medium transition-colors"
            >
              Send
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
