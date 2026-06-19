import React, { useEffect, useRef, useState, useCallback } from 'react';
import {
  View,
  Text,
  FlatList,
  Pressable,
  StyleSheet,
  ActivityIndicator,
  RefreshControl,
  StatusBar,
  TextInput,
  KeyboardAvoidingView,
  Platform,
} from 'react-native';
import BottomSheet from '@gorhom/bottom-sheet';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { PostCard } from '../src/components/PostCard';
import { ChatSheet } from '../src/components/ChatSheet';
import { FeedPicker } from '../src/components/FeedPicker';
import { useFeed } from '../src/hooks/useFeed';
import { useChat } from '../src/hooks/useChat';
import { getFeeds, createFeed } from '../src/lib/api';
import type { Feed } from '../src/lib/types';

const C = {
  bg: '#0c0c14',
  border: '#1e1e2e',
  text: '#e5e3ff',
  muted: '#5c5a7a',
  primary: '#7b6cf6',
  live: '#22c55e',
  inputBg: '#1a1a28',
};

const STAGE_LABEL: Record<string, string> = {
  searching: 'Searching…',
  thinking: 'Ranking…',
  ranking: 'Ranking…',
  skipped_rerank: 'Ready',
};

export default function HomeScreen() {
  const [feeds, setFeeds] = useState<Feed[]>([]);
  const [activeFeed, setActiveFeed] = useState<Feed | null>(null);
  const [pickerVisible, setPickerVisible] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [chatInput, setChatInput] = useState('');
  const chatSheetRef = useRef<BottomSheet>(null);
  const insets = useSafeAreaInsets();

  const { posts, loading, stage, load } = useFeed();
  const { messages, sending, send, init } = useChat(activeFeed?.id ?? null);

  useEffect(() => {
    getFeeds()
      .then((fetched) => {
        setFeeds(fetched);
        if (fetched.length > 0) setActiveFeed(fetched[0]);
      })
      .catch(console.error);
  }, []);

  useEffect(() => {
    if (!activeFeed) return;
    load(activeFeed.id);
    init(activeFeed.id, (updated) => setActiveFeed(updated));
  }, [activeFeed?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleRefresh = useCallback(async () => {
    if (!activeFeed) return;
    setRefreshing(true);
    await load(activeFeed.id, true);
    setRefreshing(false);
  }, [activeFeed, load]);

  const handleSend = useCallback(
    async (text: string) => {
      if (!text.trim()) return;
      setChatInput('');
      await send(text, (updatedFeed) => {
        setActiveFeed(updatedFeed);
        setFeeds((prev) => prev.map((f) => (f.id === updatedFeed.id ? updatedFeed : f)));
        load(updatedFeed.id, true);
      });
    },
    [send, load],
  );

  const handleCreateFeed = useCallback(async () => {
    try {
      const newFeed = await createFeed('My Feed');
      setFeeds((prev) => [...prev, newFeed]);
      setActiveFeed(newFeed);
    } catch (err) {
      console.error('[createFeed]', err);
    }
  }, []);

  return (
    <KeyboardAvoidingView
      style={[s.root, { paddingTop: insets.top }]}
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
    >
      <StatusBar barStyle="light-content" backgroundColor={C.bg} />

      {/* ── Header ── */}
      <View style={s.header}>
        <Pressable style={s.headerIconBtn} hitSlop={8}>
          <Text style={s.headerIcon}>≡</Text>
        </Pressable>

        <View style={s.headerCenter}>
          <Pressable style={s.feedNameRow} onPress={() => setPickerVisible(true)}>
            <Text style={s.feedName} numberOfLines={1}>{activeFeed?.name ?? 'Select a feed'}</Text>
          </Pressable>
          {activeFeed && (
            <View style={s.liveBadge}>
              <View style={s.liveDot} />
              <Text style={s.liveText}>LIVE</Text>
            </View>
          )}
        </View>

        <View style={s.headerActions}>
          <Pressable style={s.headerIconBtn} hitSlop={8}>
            <Text style={s.headerIcon}>⊞</Text>
          </Pressable>
          <Pressable
            style={s.headerIconBtn}
            hitSlop={8}
            onPress={() => chatSheetRef.current?.snapToIndex(0)}
          >
            <Text style={s.headerIcon}>🦋</Text>
          </Pressable>
          <Pressable style={s.headerIconBtn} hitSlop={8}>
            <Text style={s.headerIcon}>↗</Text>
          </Pressable>
        </View>
      </View>

      {/* ── Stage / post count strip ── */}
      <View style={s.strip}>
        {loading && stage ? (
          <View style={s.stageRow}>
            <ActivityIndicator size="small" color={C.primary} style={{ marginRight: 6 }} />
            <Text style={s.stripText}>{STAGE_LABEL[stage] ?? stage}</Text>
          </View>
        ) : posts.length > 0 ? (
          <Text style={s.stripText}>{posts.length} posts</Text>
        ) : null}
      </View>

      {/* ── Feed ── */}
      {activeFeed ? (
        <FlatList
          data={posts}
          keyExtractor={(p) => p.uri}
          renderItem={({ item }) => <PostCard post={item} />}
          contentContainerStyle={s.listContent}
          ListEmptyComponent={
            !loading ? (
              <View style={s.emptyWrap}>
                <Text style={s.emptyText}>
                  {stage
                    ? (STAGE_LABEL[stage] ?? 'Loading…')
                    : 'Use the chat bar below to describe what you want to read'}
                </Text>
              </View>
            ) : null
          }
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={handleRefresh}
              tintColor={C.primary}
            />
          }
        />
      ) : (
        <View style={s.noFeed}>
          <Text style={s.noFeedTitle}>No feeds yet</Text>
          <Pressable style={s.createBtn} onPress={handleCreateFeed}>
            <Text style={s.createBtnText}>Create a Feed</Text>
          </Pressable>
        </View>
      )}

      {/* ── Bottom chat bar ── */}
      {activeFeed && (
        <View style={[s.chatBar, { paddingBottom: insets.bottom + 8 }]}>
          <Pressable
            style={s.historyBtn}
            onPress={() => chatSheetRef.current?.snapToIndex(0)}
            hitSlop={8}
          >
            <View style={s.userAvatar}>
              <Text style={s.userAvatarText}>A</Text>
            </View>
          </Pressable>
          <TextInput
            style={s.chatInput}
            value={chatInput}
            onChangeText={setChatInput}
            placeholder="Describe what you want to read…"
            placeholderTextColor={C.muted}
            onSubmitEditing={() => handleSend(chatInput)}
            returnKeyType="send"
            editable={!sending}
            multiline={false}
          />
          <Pressable
            style={[s.sendBtn, (!chatInput.trim() || sending) && s.sendBtnOff]}
            onPress={() => handleSend(chatInput)}
            disabled={!chatInput.trim() || sending}
          >
            {sending ? (
              <ActivityIndicator size="small" color="#fff" />
            ) : (
              <Text style={s.sendArrow}>↑</Text>
            )}
          </Pressable>
        </View>
      )}

      {/* ── Feed picker ── */}
      <FeedPicker
        visible={pickerVisible}
        feeds={feeds}
        activeFeedId={activeFeed?.id ?? null}
        onSelect={setActiveFeed}
        onClose={() => setPickerVisible(false)}
        onCreateNew={handleCreateFeed}
      />

      {/* ── Chat history sheet ── */}
      <ChatSheet
        sheetRef={chatSheetRef}
        messages={messages}
        sending={sending}
        feedName={activeFeed?.name ?? ''}
        onSend={handleSend}
      />
    </KeyboardAvoidingView>
  );
}

const s = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: C.bg,
  },
  // Header
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: C.border,
    gap: 8,
  },
  headerCenter: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  feedNameRow: {
    flexShrink: 1,
  },
  feedName: {
    color: C.text,
    fontSize: 17,
    fontWeight: '700',
  },
  liveBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    backgroundColor: 'rgba(34,197,94,0.12)',
    paddingHorizontal: 7,
    paddingVertical: 3,
    borderRadius: 20,
    borderWidth: 1,
    borderColor: 'rgba(34,197,94,0.3)',
  },
  liveDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: C.live,
  },
  liveText: {
    color: C.live,
    fontSize: 10,
    fontWeight: '700',
    letterSpacing: 0.5,
  },
  headerActions: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  headerIconBtn: {
    width: 34,
    height: 34,
    alignItems: 'center',
    justifyContent: 'center',
  },
  headerIcon: {
    color: C.muted,
    fontSize: 18,
  },
  // Strip
  strip: {
    height: 32,
    paddingHorizontal: 16,
    justifyContent: 'center',
    alignItems: 'flex-end',
    borderBottomWidth: 1,
    borderBottomColor: C.border,
  },
  stageRow: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  stripText: {
    color: C.muted,
    fontSize: 12,
  },
  // List
  listContent: {
    paddingTop: 10,
    paddingBottom: 8,
  },
  emptyWrap: {
    paddingTop: 80,
    alignItems: 'center',
    paddingHorizontal: 40,
  },
  emptyText: {
    color: C.muted,
    fontSize: 15,
    textAlign: 'center',
    lineHeight: 22,
  },
  noFeed: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 20,
  },
  noFeedTitle: { color: C.text, fontSize: 18, fontWeight: '600' },
  createBtn: {
    backgroundColor: C.primary,
    paddingHorizontal: 28,
    paddingVertical: 13,
    borderRadius: 28,
  },
  createBtnText: { color: '#fff', fontSize: 15, fontWeight: '600' },
  // Bottom chat bar
  chatBar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: 12,
    paddingTop: 10,
    borderTopWidth: 1,
    borderTopColor: C.border,
    backgroundColor: C.bg,
  },
  historyBtn: {},
  userAvatar: {
    width: 34,
    height: 34,
    borderRadius: 17,
    backgroundColor: C.primary,
    alignItems: 'center',
    justifyContent: 'center',
  },
  userAvatarText: { color: '#fff', fontSize: 14, fontWeight: '700' },
  chatInput: {
    flex: 1,
    backgroundColor: C.inputBg,
    color: C.text,
    borderRadius: 22,
    paddingHorizontal: 16,
    paddingVertical: 9,
    fontSize: 14,
    borderWidth: 1,
    borderColor: C.border,
  },
  sendBtn: {
    width: 38,
    height: 38,
    borderRadius: 19,
    backgroundColor: C.primary,
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
  },
  sendBtnOff: { backgroundColor: '#2d2b4e' },
  sendArrow: { color: '#fff', fontSize: 18, fontWeight: '700', lineHeight: 20 },
});
