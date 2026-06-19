import { useState, useCallback } from 'react';
import { sendChat } from '../lib/api';
import type { ChatMessage, Feed } from '../lib/types';

export function useChat(feedId: number | null) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [sending, setSending] = useState(false);

  const send = useCallback(
    async (text: string, onFeedUpdate?: (feed: Feed) => void) => {
      if (!feedId || !text.trim()) return;
      setMessages((prev) => [...prev, { role: 'user', content: text }]);
      setSending(true);
      try {
        const { messages: updated, feed } = await sendChat(feedId, text);
        setMessages(updated);
        onFeedUpdate?.(feed);
      } catch (err) {
        console.error('[chat]', err);
        setMessages((prev) => [
          ...prev,
          { role: 'assistant', content: 'Something went wrong. Please try again.' },
        ]);
      } finally {
        setSending(false);
      }
    },
    [feedId],
  );

  // Loads existing chat history and gets the initial greeting
  const init = useCallback(
    async (id: number, onFeedUpdate?: (feed: Feed) => void) => {
      setSending(true);
      try {
        const { messages: initial, feed } = await sendChat(id, '__init__');
        setMessages(initial);
        onFeedUpdate?.(feed);
      } catch (err) {
        console.error('[chat init]', err);
      } finally {
        setSending(false);
      }
    },
    [],
  );

  return { messages, sending, send, init };
}
