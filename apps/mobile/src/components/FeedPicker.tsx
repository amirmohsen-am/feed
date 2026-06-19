import React from 'react';
import {
  View,
  Text,
  Modal,
  Pressable,
  FlatList,
  StyleSheet,
} from 'react-native';
import type { Feed } from '../lib/types';

const C = {
  overlay: 'rgba(0,0,0,0.72)',
  modal: '#131320',
  border: '#1e1e2e',
  text: '#e5e3ff',
  muted: '#5c5a7a',
  primary: '#7b6cf6',
  activeBg: 'rgba(123,108,246,0.10)',
};

interface Props {
  visible: boolean;
  feeds: Feed[];
  activeFeedId: number | null;
  onSelect: (feed: Feed) => void;
  onClose: () => void;
  onCreateNew: () => void;
}

export function FeedPicker({ visible, feeds, activeFeedId, onSelect, onClose, onCreateNew }: Props) {
  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      onRequestClose={onClose}
    >
      <Pressable style={s.overlay} onPress={onClose}>
        <Pressable style={s.modal} onPress={(e) => e.stopPropagation()}>
          <Text style={s.title}>Your Topics</Text>
          <FlatList
            data={feeds}
            keyExtractor={(f) => String(f.id)}
            scrollEnabled={feeds.length > 6}
            style={s.list}
            renderItem={({ item }) => (
              <Pressable
                style={[s.item, item.id === activeFeedId && s.itemActive]}
                onPress={() => { onSelect(item); onClose(); }}
              >
                <View style={[s.dot, item.id === activeFeedId && s.dotActive]} />
                <View style={s.itemBody}>
                  <Text style={s.itemName}>{item.name}</Text>
                  {item.subqueries.length > 0 && (
                    <Text style={s.itemHint} numberOfLines={1}>
                      {item.subqueries.slice(0, 2).join(' · ')}
                    </Text>
                  )}
                </View>
              </Pressable>
            )}
            ItemSeparatorComponent={() => <View style={s.sep} />}
          />
          <Pressable
            style={s.newBtn}
            onPress={() => { onCreateNew(); onClose(); }}
          >
            <Text style={s.newBtnText}>+ New Topic</Text>
          </Pressable>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

const s = StyleSheet.create({
  overlay: {
    flex: 1,
    backgroundColor: C.overlay,
    justifyContent: 'center',
    paddingHorizontal: 24,
  },
  modal: {
    backgroundColor: C.modal,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: C.border,
    overflow: 'hidden',
    maxHeight: '75%',
  },
  title: {
    color: C.text,
    fontSize: 15,
    fontWeight: '700',
    letterSpacing: 0.5,
    padding: 16,
    borderBottomWidth: 1,
    borderBottomColor: C.border,
  },
  list: { flexGrow: 0 },
  item: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 13,
    paddingHorizontal: 16,
    gap: 10,
  },
  itemActive: { backgroundColor: C.activeBg },
  dot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: C.muted,
    flexShrink: 0,
  },
  dotActive: { backgroundColor: C.primary },
  itemBody: { flex: 1 },
  itemName: { color: C.text, fontSize: 14, fontWeight: '500' },
  itemHint: { color: C.muted, fontSize: 12, marginTop: 2 },
  sep: { height: 1, backgroundColor: C.border, marginHorizontal: 16 },
  newBtn: {
    margin: 12,
    paddingVertical: 12,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: C.primary,
    alignItems: 'center',
  },
  newBtnText: { color: C.primary, fontSize: 14, fontWeight: '600' },
});
