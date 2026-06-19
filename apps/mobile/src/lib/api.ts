import type { Feed, ChatMessage, Post } from './types';

// In web mode the Metro proxy forwards /api/* to localhost:3000 same-origin,
// so no explicit base URL is needed. For native builds, set EXPO_PUBLIC_API_URL.
const API_BASE = process.env.EXPO_PUBLIC_API_URL ?? '';

const BASE_OPTS: RequestInit = { credentials: 'include' };

async function apiFetch(path: string, init?: RequestInit): Promise<Response> {
  const res = await fetch(`${API_BASE}${path}`, { ...BASE_OPTS, ...init });
  if (res.status === 429) {
    const data = await res.json().catch(() => ({}));
    throw Object.assign(new Error('Rate limited'), { retryAfter: data.retryAfter });
  }
  return res;
}

export async function getFeeds(): Promise<Feed[]> {
  const res = await apiFetch('/api/feeds');
  if (!res.ok) throw new Error(`getFeeds ${res.status}`);
  return (await res.json()).feeds;
}

export async function createFeed(name = 'My Feed'): Promise<Feed> {
  const res = await apiFetch('/api/feeds', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  });
  if (!res.ok) throw new Error(`createFeed ${res.status}`);
  return (await res.json()).feed;
}

export type StreamEvent =
  | { event: 'stage'; stage: string; candidates?: number; hits?: number }
  | { event: 'done'; posts: Post[]; cached: boolean; ms_total: number }
  | { event: 'error'; message: string };

export async function* streamFeedPosts(
  feedId: number,
  refresh = false,
): AsyncGenerator<StreamEvent> {
  const qs = refresh ? '&refresh=1' : '';
  const res = await apiFetch(`/api/feed-preview/stream?feedId=${feedId}${qs}`, {
    headers: { Accept: 'application/x-ndjson' },
  });
  if (!res.ok) throw new Error(`streamFeedPosts ${res.status}`);

  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        yield JSON.parse(trimmed) as StreamEvent;
      } catch {
        // ignore malformed lines
      }
    }
  }
}

export async function sendChat(
  feedId: number,
  message: string,
): Promise<{ messages: ChatMessage[]; feed: Feed }> {
  const res = await apiFetch('/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ feedId, message }),
  });
  if (!res.ok) throw new Error(`sendChat ${res.status}`);
  return res.json();
}
