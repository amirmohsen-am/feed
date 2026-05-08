"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import ImportMemoryModal from "./ImportMemoryModal";

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

interface Feed {
  id: number;
  name: string;
  description: string;
  criteria: FeedCriteria;
  created_at: string;
  updated_at: string;
}

function parseAssistantMessage(content: string) {
  const lines = content.split("\n");
  const options: { key: string; label: string }[] = [];
  const textLines: string[] = [];

  for (const line of lines) {
    const optMatch = line.match(/^(\d)\.\s+(.+)/);
    if (optMatch) {
      options.push({ key: optMatch[1], label: optMatch[2] });
    } else {
      textLines.push(line);
    }
  }

  return { text: textLines.join("\n").trim(), options };
}

export default function Chat() {
  const [feeds, setFeeds] = useState<Feed[]>([]);
  const [activeFeedId, setActiveFeedId] = useState<number | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [ready, setReady] = useState(false);
  const [chatDone, setChatDone] = useState(false);
  const [showImportModal, setShowImportModal] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  const activeFeed = feeds.find((f) => f.id === activeFeedId) ?? null;

  // Load feeds on mount
  useEffect(() => {
    fetch("/api/feeds")
      .then((r) => r.json())
      .then((data) => {
        setFeeds(data.feeds || []);
        setReady(true);
      });
  }, []);

  // Load messages when active feed changes
  const loadMessages = useCallback(async (feedId: number) => {
    const res = await fetch(`/api/chat?feedId=${feedId}`);
    const data = await res.json();
    const msgs: Message[] = data.messages || [];

    if (msgs.length === 0) {
      // Auto-start: curator leads
      setLoading(true);
      try {
        const initRes = await fetch("/api/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ feedId, message: "__init__" }),
        });
        const initData = await initRes.json();
        setMessages(initData.messages || []);
        if (initData.feed) refreshFeed(initData.feed);
      } catch {
        setMessages([
          { role: "assistant", content: "Hey! What kind of content are you into?" },
        ]);
      } finally {
        setLoading(false);
      }
    } else {
      setMessages(msgs);
    }
  }, []);

  useEffect(() => {
    if (activeFeedId) {
      setMessages([]);
      setChatDone(false);
      loadMessages(activeFeedId);
    }
  }, [activeFeedId, loadMessages]);

  function refreshFeed(updated: Feed) {
    setFeeds((prev) =>
      prev.map((f) => (f.id === updated.id ? updated : f))
    );
  }

  async function createNewFeed() {
    const res = await fetch("/api/feeds", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    const data = await res.json();
    if (data.feed) {
      setFeeds((prev) => [data.feed, ...prev]);
      setActiveFeedId(data.feed.id);
    }
  }

  function handleMemoryImported(feed: Feed) {
    setFeeds((prev) => [feed, ...prev]);
    setActiveFeedId(feed.id);
    setShowImportModal(false);
  }

  async function handleDeleteFeed(id: number) {
    await fetch("/api/feeds", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id }),
    });
    setFeeds((prev) => prev.filter((f) => f.id !== id));
    if (activeFeedId === id) {
      setActiveFeedId(null);
      setMessages([]);
    }
  }

  async function send(text: string) {
    if (!text.trim() || loading || !activeFeedId || chatDone) return;

    setInput("");
    setMessages((prev) => [...prev, { role: "user", content: text.trim() }]);
    setLoading(true);

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ feedId: activeFeedId, message: text.trim() }),
      });
      const data = await res.json();
      setMessages(data.messages || []);
      if (data.feed) refreshFeed(data.feed);
      if (data.done) setChatDone(true);
    } catch {
      setMessages((prev) => [
        ...prev,
        { role: "assistant", content: "Something went wrong. Try again." },
      ]);
    } finally {
      setLoading(false);
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    await send(input);
  }

  function handleOptionClick(opt: { key: string; label: string }) {
    send(`${opt.key}. ${opt.label}`);
  }

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  const lastMessage = messages[messages.length - 1];
  const lastParsed =
    lastMessage?.role === "assistant"
      ? parseAssistantMessage(lastMessage.content)
      : null;

  if (!ready) {
    return (
      <div className="flex h-screen bg-gray-950 text-gray-100 items-center justify-center">
        <div className="text-gray-500 text-sm">Loading...</div>
      </div>
    );
  }

  return (
    <div className="flex h-screen bg-gray-950 text-gray-100">
      {/* Sidebar */}
      <div className="w-64 border-r border-gray-800/60 flex flex-col">
        <div className="p-4 border-b border-gray-800/60 flex items-center justify-between">
          <h2 className="text-xs font-semibold text-gray-500 uppercase tracking-wider">
            My Feeds
          </h2>
          <div className="flex items-center gap-1">
            <button
              onClick={() => setShowImportModal(true)}
              title="Import AI memory"
              className="text-gray-500 hover:text-gray-300 transition-colors p-1.5 rounded hover:bg-gray-800"
            >
              <svg
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M12 2L15.09 8.26L22 9.27L17 14.14L18.18 21.02L12 17.77L5.82 21.02L7 14.14L2 9.27L8.91 8.26L12 2Z" />
              </svg>
            </button>
            <button
              onClick={createNewFeed}
              className="text-xs text-gray-500 hover:text-gray-300 transition-colors px-2 py-1 rounded hover:bg-gray-800"
            >
              + New
            </button>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto p-2 space-y-1">
          {feeds.length === 0 && (
            <div className="px-3 py-8 text-center">
              <p className="text-xs text-gray-600 mb-3">No feeds yet</p>
              <button
                onClick={createNewFeed}
                className="text-xs text-blue-400 hover:text-blue-300 transition-colors"
              >
                Create your first feed
              </button>
            </div>
          )}
          {feeds.map((feed) => (
            <div
              key={feed.id}
              onClick={() => setActiveFeedId(feed.id)}
              className={`group flex items-center justify-between px-3 py-2.5 rounded-lg cursor-pointer transition-colors ${
                activeFeedId === feed.id
                  ? "bg-gray-800 text-gray-100"
                  : "text-gray-400 hover:bg-gray-800/50 hover:text-gray-300"
              }`}
            >
              <div className="min-w-0 flex-1">
                <p className="text-sm truncate">{feed.name}</p>
                {feed.criteria.topics.length > 0 && (
                  <p className="text-xs text-gray-600 truncate mt-0.5">
                    {feed.criteria.topics.join(", ")}
                  </p>
                )}
              </div>
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  handleDeleteFeed(feed.id);
                }}
                className="opacity-0 group-hover:opacity-100 text-gray-600 hover:text-red-400 transition-all ml-2 text-xs"
              >
                &times;
              </button>
            </div>
          ))}
        </div>
      </div>

      {/* Main area */}
      <div className="flex-1 flex flex-col">
        {!activeFeedId ? (
          <div className="flex-1 flex items-center justify-center">
            <div className="text-center">
              <p className="text-gray-500 text-sm mb-4">
                Select a feed or create a new one
              </p>
              <button
                onClick={createNewFeed}
                className="px-4 py-2 bg-gray-800 hover:bg-gray-700 rounded-lg text-sm text-gray-300 transition-colors"
              >
                + New Feed
              </button>
            </div>
          </div>
        ) : (
          <>
            <div className="border-b border-gray-800/60 px-8 py-4 flex items-center justify-between">
              <div>
                <h1 className="text-base font-medium">
                  {activeFeed?.name || "Untitled"}
                </h1>
                {activeFeed &&
                  activeFeed.criteria.topics.length > 0 && (
                    <div className="flex gap-1.5 mt-1.5">
                      {activeFeed.criteria.topics.map((t) => (
                        <span
                          key={t}
                          className="px-1.5 py-0.5 bg-blue-500/15 text-blue-400 rounded text-xs"
                        >
                          {t}
                        </span>
                      ))}
                    </div>
                  )}
              </div>
            </div>

            <div className="flex-1 overflow-y-auto px-8 py-6">
              <div className="max-w-2xl mx-auto space-y-6">
                {messages.map((msg, i) => {
                  const isUser = msg.role === "user";
                  const isLast = i === messages.length - 1;
                  const parsed = !isUser
                    ? parseAssistantMessage(msg.content)
                    : null;

                  return (
                    <div key={i}>
                      {isUser ? (
                        <div className="text-sm text-gray-400 pl-4 border-l-2 border-gray-800">
                          {msg.content}
                        </div>
                      ) : (
                        <div className="space-y-3">
                          {parsed!.text.split("\n\n").map((para, j) => (
                            <p
                              key={j}
                              className="text-sm text-gray-200 leading-relaxed"
                            >
                              {para}
                            </p>
                          ))}

                          {parsed!.options.length > 0 && (
                            <div className="flex flex-col gap-2 pt-2">
                              {parsed!.options.map((opt) => (
                                <button
                                  key={opt.key}
                                  onClick={() =>
                                    isLast && !loading
                                      ? handleOptionClick(opt)
                                      : undefined
                                  }
                                  disabled={!isLast || loading}
                                  className={`text-left text-sm px-3 py-2 rounded-lg border transition-colors ${
                                    isLast && !loading
                                      ? "border-gray-700 text-gray-300 hover:border-blue-500/50 hover:text-blue-300 hover:bg-blue-500/5 cursor-pointer"
                                      : "border-gray-800/50 text-gray-600 cursor-default"
                                  }`}
                                >
                                  <span className="text-gray-500 mr-2 font-mono text-xs">
                                    {opt.key}
                                  </span>
                                  {opt.label}
                                </button>
                              ))}
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}

                {loading && (
                  <div className="flex gap-1.5 py-2">
                    <span className="w-1.5 h-1.5 bg-gray-600 rounded-full animate-bounce" />
                    <span className="w-1.5 h-1.5 bg-gray-600 rounded-full animate-bounce [animation-delay:0.1s]" />
                    <span className="w-1.5 h-1.5 bg-gray-600 rounded-full animate-bounce [animation-delay:0.2s]" />
                  </div>
                )}
                <div ref={messagesEndRef} />
              </div>
            </div>

            {chatDone ? (
              <div className="border-t border-gray-800/60 px-8 py-4">
                <div className="max-w-2xl mx-auto flex items-center justify-between">
                  <p className="text-sm text-gray-500">
                    Feed locked in. You're good to go.
                  </p>
                  <button
                    onClick={() => setChatDone(false)}
                    className="text-xs text-gray-500 hover:text-gray-300 transition-colors px-3 py-1.5 rounded-lg hover:bg-gray-800"
                  >
                    Make changes
                  </button>
                </div>
              </div>
            ) : (
              <form
                onSubmit={handleSubmit}
                className="border-t border-gray-800/60 px-8 py-4"
              >
                <div className="max-w-2xl mx-auto flex gap-3">
                  <input
                    type="text"
                    value={input}
                    onChange={(e) => setInput(e.target.value)}
                    placeholder={
                      lastParsed?.options.length
                        ? "Pick an option above or type your own..."
                        : "Type here..."
                    }
                    className="flex-1 bg-gray-900 border border-gray-800 rounded-lg px-4 py-2.5 text-sm
                               placeholder-gray-600 focus:outline-none focus:border-gray-700 transition-colors"
                    disabled={loading}
                  />
                  <button
                    type="submit"
                    disabled={loading || !input.trim()}
                    className="px-4 py-2.5 bg-gray-800 hover:bg-gray-700 disabled:opacity-30
                               rounded-lg text-sm transition-colors"
                  >
                    Send
                  </button>
                </div>
              </form>
            )}
          </>
        )}
      </div>

      {showImportModal && (
        <ImportMemoryModal
          onClose={() => setShowImportModal(false)}
          onImported={handleMemoryImported}
        />
      )}
    </div>
  );
}
