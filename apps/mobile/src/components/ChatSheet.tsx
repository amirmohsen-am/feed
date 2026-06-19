import React, { useRef, useCallback, useMemo, useState } from 'react';
import {
  View,
  Text,
  Pressable,
  StyleSheet,
  type ListRenderItem,
} from 'react-native';
import BottomSheet, {
  BottomSheetFlatList,
  BottomSheetTextInput,
  type BottomSheetFlatListMethods,
} from '@gorhom/bottom-sheet';
import type { ChatMessage } from '../lib/types';

const C = {
  sheet: '#131320',
  border: '#1e1e2e',
  handle: '#3a3850',
  text: '#e5e3ff',
  muted: '#5c5a7a',
  primary: '#7b6cf6',
  userBubble: '#2d2b4e',
  assistantBubble: '#0f0f1c',
  input: '#1e1e2e',
};

interface Props {
  sheetRef: React.RefObject<BottomSheet | null>;
  messages: ChatMessage[];
  sending: boolean;
  feedName: string;
  onSend: (text: string) => void;
}

function isSwipeToken(content: string): boolean {
  return content.includes('⟦swipe:');
}

export function ChatSheet({ sheetRef, messages, sending, feedName, onSend }: Props) {
  const [input, setInput] = useState('');
  const snapPoints = useMemo(() => ['45%', '88%'], []);
  const listRef = useRef<BottomSheetFlatListMethods>(null);

  const handleSend = useCallback(() => {
    const text = input.trim();
    if (!text || sending) return;
    setInput('');
    onSend(text);
  }, [input, sending, onSend]);

  const visible = messages.filter((m) => !isSwipeToken(m.content));

  const renderItem: ListRenderItem<ChatMessage> = useCallback(({ item }) => (
    <View
      style={[
        s.bubble,
        item.role === 'user' ? s.userBubble : s.assistantBubble,
      ]}
    >
      <Text style={s.bubbleText}>{item.content}</Text>
    </View>
  ), []);

  return (
    <BottomSheet
      ref={sheetRef}
      index={-1}
      snapPoints={snapPoints}
      enablePanDownToClose
      backgroundStyle={s.sheet}
      handleIndicatorStyle={s.handleBar}
    >
      {/* Header */}
      <View style={s.header}>
        <View>
          <Text style={s.headerTitle}>Tune Feed</Text>
          {!!feedName && (
            <Text style={s.headerFeed} numberOfLines={1}>{feedName}</Text>
          )}
        </View>
        <Pressable onPress={() => sheetRef.current?.close()} hitSlop={12}>
          <Text style={s.closeBtn}>✕</Text>
        </Pressable>
      </View>

      {/* Messages */}
      <BottomSheetFlatList
        ref={listRef}
        data={visible}
        keyExtractor={(_, i) => String(i)}
        renderItem={renderItem}
        contentContainerStyle={s.messageList}
        onContentSizeChange={() => listRef.current?.scrollToEnd({ animated: true })}
      />

      {/* Typing indicator */}
      {sending && (
        <View style={s.typingRow}>
          <Text style={s.typingDot}>● ● ●</Text>
        </View>
      )}

      {/* Input */}
      <View style={s.inputRow}>
        <BottomSheetTextInput
          style={s.input}
          value={input}
          onChangeText={setInput}
          placeholder="What should your feed include?"
          placeholderTextColor={C.muted}
          onSubmitEditing={handleSend}
          returnKeyType="send"
          editable={!sending}
          multiline
          blurOnSubmit
        />
        <Pressable
          onPress={handleSend}
          disabled={!input.trim() || sending}
          style={[s.sendBtn, (!input.trim() || sending) && s.sendBtnOff]}
        >
          <Text style={s.sendArrow}>↑</Text>
        </Pressable>
      </View>
    </BottomSheet>
  );
}

const s = StyleSheet.create({
  sheet: {
    backgroundColor: C.sheet,
    borderTopWidth: 1,
    borderTopColor: C.border,
  },
  handleBar: {
    backgroundColor: C.handle,
    width: 40,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingBottom: 12,
    borderBottomWidth: 1,
    borderBottomColor: C.border,
  },
  headerTitle: {
    color: C.text,
    fontSize: 16,
    fontWeight: '700',
    letterSpacing: 0.3,
  },
  headerFeed: {
    color: C.primary,
    fontSize: 12,
    marginTop: 2,
  },
  closeBtn: {
    color: C.muted,
    fontSize: 16,
    paddingTop: 2,
  },
  messageList: {
    padding: 16,
    gap: 10,
    paddingBottom: 4,
  },
  bubble: {
    maxWidth: '85%',
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: 14,
  },
  userBubble: {
    backgroundColor: C.userBubble,
    alignSelf: 'flex-end',
    borderBottomRightRadius: 4,
  },
  assistantBubble: {
    backgroundColor: C.assistantBubble,
    alignSelf: 'flex-start',
    borderBottomLeftRadius: 4,
    borderWidth: 1,
    borderColor: C.border,
  },
  bubbleText: {
    color: C.text,
    fontSize: 14,
    lineHeight: 20,
  },
  typingRow: {
    paddingHorizontal: 18,
    paddingVertical: 8,
  },
  typingDot: {
    color: C.muted,
    fontSize: 10,
    letterSpacing: 4,
  },
  inputRow: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: 8,
    paddingHorizontal: 12,
    paddingTop: 10,
    paddingBottom: 24,
    borderTopWidth: 1,
    borderTopColor: C.border,
  },
  input: {
    flex: 1,
    backgroundColor: C.input,
    color: C.text,
    borderRadius: 20,
    paddingHorizontal: 16,
    paddingVertical: 10,
    fontSize: 14,
    maxHeight: 100,
  },
  sendBtn: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: C.primary,
    alignItems: 'center',
    justifyContent: 'center',
  },
  sendBtnOff: {
    backgroundColor: '#2d2b4e',
  },
  sendArrow: {
    color: '#fff',
    fontSize: 20,
    fontWeight: '700',
    lineHeight: 22,
  },
});
