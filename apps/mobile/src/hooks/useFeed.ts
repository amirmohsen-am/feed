import { useState, useCallback } from 'react';
import { streamFeedPosts } from '../lib/api';
import type { Post, FeedStage } from '../lib/types';

export function useFeed() {
  const [posts, setPosts] = useState<Post[]>([]);
  const [loading, setLoading] = useState(false);
  const [stage, setStage] = useState<FeedStage | null>(null);

  const load = useCallback(async (feedId: number, refresh = false) => {
    setLoading(true);
    setStage('searching');
    setPosts([]);

    try {
      for await (const event of streamFeedPosts(feedId, refresh)) {
        if (event.event === 'stage') {
          setStage(event.stage as FeedStage);
        } else if (event.event === 'done') {
          setPosts(event.posts);
          setStage(null);
        } else if (event.event === 'error') {
          console.error('[feed]', event.message);
          setStage(null);
        }
      }
    } catch (err) {
      console.error('[feed stream]', err);
      setStage(null);
    } finally {
      setLoading(false);
    }
  }, []);

  return { posts, loading, stage, load };
}
