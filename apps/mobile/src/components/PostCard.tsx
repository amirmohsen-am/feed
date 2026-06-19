import React from 'react';
import { View, Text, Image, StyleSheet, Pressable, type GestureResponderEvent } from 'react-native';
import type { Post } from '../lib/types';

const C = {
  bg: '#0c0c14',
  card: '#131320',
  border: '#1e1e2e',
  text: '#e5e3ff',
  textMid: '#b0aed0',
  muted: '#5c5a7a',
  primary: '#7b6cf6',
  linkBg: '#0f0f1c',
  linkBorder: '#252338',
};

const AVATAR_PALETTE = ['#7b6cf6', '#e879a8', '#38bdf8', '#4ade80', '#fb923c'];

function avatarColor(did: string): string {
  let h = 0;
  for (const ch of did) h = ((h << 5) - h + ch.charCodeAt(0)) | 0;
  return AVATAR_PALETTE[Math.abs(h) % AVATAR_PALETTE.length];
}

function initial(display: string | null, handle: string | null): string {
  return (display || handle || '?').charAt(0).toUpperCase();
}

function timeAgo(iso: string): string {
  const s = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

function fmt(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

function domainOf(uri: string | null): string {
  if (!uri) return '';
  try { return new URL(uri).hostname.replace(/^www\./, '').toUpperCase(); } catch { return ''; }
}

export function PostCard({ post }: { post: Post }) {
  const name = post.author_display_name || post.author_handle || 'Unknown';
  const handle = post.author_handle ? `@${post.author_handle}` : '';
  const avatarUri =
    post.author_avatar_cid && post.author_did
      ? `https://cdn.bsky.app/img/avatar/plain/${post.author_did}/${post.author_avatar_cid}@jpeg`
      : null;

  return (
    <View style={s.card}>
      {/* Author row */}
      <View style={s.header}>
        <View style={[s.avatar, { backgroundColor: avatarColor(post.author_did) }]}>
          {avatarUri ? (
            <Image source={{ uri: avatarUri }} style={s.avatarImg} />
          ) : (
            <Text style={s.avatarLetter}>{initial(post.author_display_name, post.author_handle)}</Text>
          )}
        </View>
        <View style={s.authorMeta}>
          <Text style={s.displayName} numberOfLines={1}>{name}</Text>
          <Text style={s.handleTime} numberOfLines={1}>
            {handle}{handle ? ' · ' : ''}{timeAgo(post.indexed_at)}
          </Text>
        </View>
        <Pressable style={s.followBtn} hitSlop={8}>
          <Text style={s.followIcon}>⊕</Text>
        </Pressable>
      </View>

      {/* Post text */}
      {!!post.text && <Text style={s.body}>{post.text}</Text>}

      {/* External link card */}
      {!!post.external_title && (
        <View style={s.linkCard}>
          {!!post.external_uri && (
            <Text style={s.linkDomain}>{domainOf(post.external_uri)}</Text>
          )}
          <Text style={s.linkTitle} numberOfLines={2}>{post.external_title}</Text>
          {!!post.external_desc && (
            <Text style={s.linkDesc} numberOfLines={2}>{post.external_desc}</Text>
          )}
          {!!post.external_thumb && (
            <Image
              source={{ uri: post.external_thumb }}
              style={s.linkImage}
              resizeMode="cover"
            />
          )}
        </View>
      )}

      {/* Post images (when no external link) */}
      {!post.external_title && post.has_images && post.image_urls.length > 0 && (
        <Image
          source={{ uri: post.image_urls[0] }}
          style={s.postImage}
          resizeMode="cover"
        />
      )}

      {/* Stats */}
      <View style={s.stats}>
        <StatItem icon="○" value={post.reply_count} />
        <StatItem icon="↺" value={post.repost_count} />
        <StatItem icon="♡" value={post.like_count} />
        <StatItem icon='❝' value={post.quote_count} />
      </View>
    </View>
  );
}

function StatItem({ icon, value, onPress }: { icon: string; value: number; onPress?: (e: GestureResponderEvent) => void }) {
  return (
    <Pressable style={s.statItem} onPress={onPress} hitSlop={4}>
      <Text style={s.statIcon}>{icon}</Text>
      <Text style={s.statVal}>{fmt(value)}</Text>
    </Pressable>
  );
}

const s = StyleSheet.create({
  card: {
    backgroundColor: C.card,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: C.border,
    marginHorizontal: 12,
    marginBottom: 10,
    paddingTop: 14,
    paddingHorizontal: 14,
    paddingBottom: 0,
    overflow: 'hidden',
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 10,
  },
  avatar: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
    marginRight: 10,
    flexShrink: 0,
  },
  avatarImg: { width: '100%', height: '100%' },
  avatarLetter: { color: '#fff', fontSize: 17, fontWeight: '700' },
  authorMeta: { flex: 1 },
  displayName: { color: C.text, fontSize: 14, fontWeight: '700' },
  handleTime: { color: C.muted, fontSize: 12, marginTop: 2 },
  followBtn: {
    width: 30,
    height: 30,
    borderRadius: 15,
    borderWidth: 1,
    borderColor: C.border,
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
  },
  followIcon: { color: C.primary, fontSize: 16 },
  body: {
    color: C.text,
    fontSize: 15,
    lineHeight: 22,
    marginBottom: 12,
  },
  // External link card
  linkCard: {
    borderWidth: 1,
    borderColor: C.linkBorder,
    borderRadius: 8,
    backgroundColor: C.linkBg,
    overflow: 'hidden',
    marginBottom: 12,
  },
  linkDomain: {
    color: C.muted,
    fontSize: 10,
    fontWeight: '600',
    letterSpacing: 0.8,
    paddingHorizontal: 12,
    paddingTop: 10,
    paddingBottom: 2,
  },
  linkTitle: {
    color: C.text,
    fontSize: 14,
    fontWeight: '700',
    paddingHorizontal: 12,
    paddingBottom: 4,
  },
  linkDesc: {
    color: C.textMid,
    fontSize: 13,
    lineHeight: 18,
    paddingHorizontal: 12,
    paddingBottom: 10,
  },
  linkImage: {
    width: '100%',
    height: 180,
  },
  postImage: {
    width: '100%',
    height: 200,
    borderRadius: 8,
    marginBottom: 12,
  },
  // Stats — pulled edge-to-edge to escape card padding
  stats: {
    flexDirection: 'row',
    marginHorizontal: -14,
    marginTop: 12,
    borderTopWidth: 1,
    borderTopColor: C.border,
  },
  statItem: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    flex: 1,
    paddingVertical: 12,
  },
  statIcon: { color: C.muted, fontSize: 16 },
  statVal: { color: C.muted, fontSize: 14 },
});
