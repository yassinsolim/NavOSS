import type { Coordinate, SearchResult } from '@navoss/contracts';
import { SymbolView } from 'expo-symbols';
import { useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Keyboard,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { NavOssColors, NavOssFonts } from '@/constants/navoss-theme';
import {
  formatSearchDistance,
  rankSearchResults,
  searchProximityOptions,
  searchResultContext,
} from '@/features/map/search-proximity';
import { searchPlaces } from '@/lib/api';

interface RouteStopsEditorProps {
  destinations: readonly SearchResult[];
  onApply: (destinations: SearchResult[]) => void;
  onClose: () => void;
  origin?: Coordinate;
  visible: boolean;
}

export function RouteStopsEditor({
  destinations,
  onApply,
  onClose,
  origin,
  visible,
}: RouteStopsEditorProps) {
  const insets = useSafeAreaInsets();
  const [draft, setDraft] = useState<SearchResult[]>([]);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SearchResult[]>([]);
  const [searching, setSearching] = useState(false);

  useEffect(() => {
    if (!visible) return;
    setDraft([...destinations]);
    setQuery('');
    setResults([]);
    setSearching(false);
  }, [destinations, visible]);

  const moveDestination = (index: number, offset: -1 | 1) => {
    const nextIndex = index + offset;
    if (nextIndex < 0 || nextIndex >= draft.length) return;
    setDraft((current) => {
      const next = [...current];
      const destination = next[index];
      const neighbor = next[nextIndex];
      if (destination === undefined || neighbor === undefined) return current;
      next[index] = neighbor;
      next[nextIndex] = destination;
      return next;
    });
  };

  const runSearch = async () => {
    const normalizedQuery = query.trim();
    if (normalizedQuery.length < 2 || searching) return;
    Keyboard.dismiss();
    setSearching(true);
    try {
      const response = await searchPlaces(normalizedQuery, searchProximityOptions(origin));
      setResults(rankSearchResults(response.results, [], origin));
    } catch {
      setResults([]);
    } finally {
      setSearching(false);
    }
  };

  return (
    <Modal
      animationType="slide"
      onRequestClose={onClose}
      presentationStyle="fullScreen"
      visible={visible}
    >
      <View style={[styles.safeArea, { paddingBottom: insets.bottom, paddingTop: insets.top }]}>
        <View style={styles.header}>
          <Pressable
            accessibilityLabel="Cancel editing stops"
            onPress={onClose}
            style={styles.headerButton}
          >
            <SymbolView
              name={{ android: 'close', ios: 'xmark' }}
              size={20}
              tintColor={NavOssColors.asphalt}
            />
          </Pressable>
          <Text style={styles.title}>Edit stops</Text>
          <Pressable
            accessibilityLabel="Apply route stops"
            disabled={draft.length === 0}
            onPress={() => {
              onApply(draft);
            }}
            style={[styles.doneButton, draft.length === 0 && styles.buttonDisabled]}
          >
            <Text style={styles.doneText}>Done</Text>
          </Pressable>
        </View>

        <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
          <View style={styles.routeList}>
            <View style={styles.routeRow}>
              <View style={styles.originMarker}>
                <SymbolView
                  name={{ android: 'my_location', ios: 'location.fill' }}
                  size={16}
                  tintColor={NavOssColors.white}
                />
              </View>
              <View style={styles.routeCopy}>
                <Text style={styles.routeKind}>START</Text>
                <Text numberOfLines={1} style={styles.routeName}>
                  My location
                </Text>
              </View>
            </View>

            {draft.map((destination, index) => {
              const finalDestination = index === draft.length - 1;
              return (
                <View key={`${destination.id}:${String(index)}`} style={styles.routeRow}>
                  <View style={finalDestination ? styles.destinationMarker : styles.stopMarker}>
                    <Text style={styles.markerText}>
                      {finalDestination ? 'B' : String(index + 1)}
                    </Text>
                  </View>
                  <View style={styles.routeCopy}>
                    <Text style={styles.routeKind}>
                      {finalDestination ? 'DESTINATION' : `STOP ${String(index + 1)}`}
                    </Text>
                    <Text numberOfLines={1} style={styles.routeName}>
                      {destination.name}
                    </Text>
                    <Text numberOfLines={1} style={styles.routeContext}>
                      {searchResultContext(destination)}
                    </Text>
                  </View>
                  <View style={styles.rowActions}>
                    <Pressable
                      accessibilityLabel={`Move ${destination.name} up`}
                      disabled={index === 0}
                      onPress={() => {
                        moveDestination(index, -1);
                      }}
                      style={[styles.iconButton, index === 0 && styles.buttonDisabled]}
                    >
                      <SymbolView
                        name={{ android: 'arrow_upward', ios: 'arrow.up' }}
                        size={17}
                        tintColor={NavOssColors.asphalt}
                      />
                    </Pressable>
                    <Pressable
                      accessibilityLabel={`Move ${destination.name} down`}
                      disabled={finalDestination}
                      onPress={() => {
                        moveDestination(index, 1);
                      }}
                      style={[styles.iconButton, finalDestination && styles.buttonDisabled]}
                    >
                      <SymbolView
                        name={{ android: 'arrow_downward', ios: 'arrow.down' }}
                        size={17}
                        tintColor={NavOssColors.asphalt}
                      />
                    </Pressable>
                    <Pressable
                      accessibilityLabel={`Remove ${destination.name}`}
                      disabled={draft.length === 1}
                      onPress={() => {
                        setDraft((current) =>
                          current.filter((_, itemIndex) => itemIndex !== index),
                        );
                      }}
                      style={[styles.iconButton, draft.length === 1 && styles.buttonDisabled]}
                    >
                      <SymbolView
                        name={{ android: 'delete', ios: 'trash' }}
                        size={17}
                        tintColor={NavOssColors.coral}
                      />
                    </Pressable>
                  </View>
                </View>
              );
            })}
          </View>

          {draft.length < 9 && (
            <View style={styles.addSection}>
              <Text style={styles.sectionTitle}>Add a stop</Text>
              <View style={styles.searchRow}>
                <TextInput
                  accessibilityLabel="Search for a stop"
                  autoCapitalize="words"
                  enterKeyHint="search"
                  onChangeText={setQuery}
                  onSubmitEditing={() => {
                    void runSearch();
                  }}
                  placeholder="Search places"
                  placeholderTextColor={NavOssColors.muted}
                  style={styles.searchInput}
                  value={query}
                />
                <Pressable
                  accessibilityLabel="Search stops"
                  onPress={() => {
                    void runSearch();
                  }}
                  style={styles.searchButton}
                >
                  {searching ? (
                    <ActivityIndicator color={NavOssColors.white} size="small" />
                  ) : (
                    <SymbolView
                      name={{ android: 'search', ios: 'magnifyingglass' }}
                      size={19}
                      tintColor={NavOssColors.white}
                    />
                  )}
                </Pressable>
              </View>
              <View style={styles.results}>
                {results.map((result) => (
                  <Pressable
                    accessibilityLabel={`Add ${result.name} as a stop`}
                    key={result.id}
                    onPress={() => {
                      setDraft((current) => [...current, result]);
                      setQuery('');
                      setResults([]);
                    }}
                    style={styles.resultRow}
                  >
                    <SymbolView
                      name={{ android: 'add_location', ios: 'plus.circle.fill' }}
                      size={21}
                      tintColor={NavOssColors.green}
                    />
                    <View style={styles.resultCopy}>
                      <Text numberOfLines={1} style={styles.resultName}>
                        {result.name}
                      </Text>
                      <Text numberOfLines={1} style={styles.resultContext}>
                        {searchResultContext(result)}
                      </Text>
                    </View>
                    <Text style={styles.distance}>
                      {formatSearchDistance(result.distanceMeters)}
                    </Text>
                  </Pressable>
                ))}
              </View>
            </View>
          )}
        </ScrollView>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  addSection: { gap: 12 },
  buttonDisabled: { opacity: 0.35 },
  content: { gap: 24, padding: 16, paddingBottom: 40 },
  destinationMarker: {
    alignItems: 'center',
    backgroundColor: NavOssColors.coral,
    borderRadius: 16,
    height: 32,
    justifyContent: 'center',
    width: 32,
  },
  distance: {
    color: NavOssColors.muted,
    fontFamily: NavOssFonts.medium,
    fontSize: 13,
    letterSpacing: 0,
  },
  doneButton: {
    alignItems: 'center',
    backgroundColor: NavOssColors.green,
    borderRadius: 8,
    height: 40,
    justifyContent: 'center',
    minWidth: 66,
    paddingHorizontal: 14,
  },
  doneText: {
    color: NavOssColors.white,
    fontFamily: NavOssFonts.semibold,
    fontSize: 16,
    letterSpacing: 0,
  },
  header: {
    alignItems: 'center',
    borderBottomColor: NavOssColors.border,
    borderBottomWidth: StyleSheet.hairlineWidth,
    flexDirection: 'row',
    justifyContent: 'space-between',
    minHeight: 60,
    paddingHorizontal: 12,
  },
  headerButton: { alignItems: 'center', height: 44, justifyContent: 'center', width: 44 },
  iconButton: {
    alignItems: 'center',
    backgroundColor: NavOssColors.fog,
    borderRadius: 6,
    height: 32,
    justifyContent: 'center',
    width: 32,
  },
  markerText: {
    color: NavOssColors.white,
    fontFamily: NavOssFonts.bold,
    fontSize: 14,
    letterSpacing: 0,
  },
  originMarker: {
    alignItems: 'center',
    backgroundColor: NavOssColors.green,
    borderRadius: 16,
    height: 32,
    justifyContent: 'center',
    width: 32,
  },
  resultContext: {
    color: NavOssColors.muted,
    fontFamily: NavOssFonts.regular,
    fontSize: 13,
    letterSpacing: 0,
  },
  resultCopy: { flex: 1, gap: 2, minWidth: 0 },
  resultName: {
    color: NavOssColors.asphalt,
    fontFamily: NavOssFonts.semibold,
    fontSize: 16,
    letterSpacing: 0,
  },
  resultRow: {
    alignItems: 'center',
    borderBottomColor: NavOssColors.border,
    borderBottomWidth: StyleSheet.hairlineWidth,
    flexDirection: 'row',
    gap: 10,
    minHeight: 62,
    paddingHorizontal: 4,
    paddingVertical: 8,
  },
  results: {
    borderColor: NavOssColors.border,
    borderRadius: 8,
    borderWidth: StyleSheet.hairlineWidth,
    overflow: 'hidden',
  },
  routeContext: {
    color: NavOssColors.muted,
    fontFamily: NavOssFonts.regular,
    fontSize: 12,
    letterSpacing: 0,
  },
  routeCopy: { flex: 1, gap: 2, minWidth: 0 },
  routeKind: {
    color: NavOssColors.green,
    fontFamily: NavOssFonts.bold,
    fontSize: 11,
    letterSpacing: 0,
  },
  routeList: {
    borderColor: NavOssColors.border,
    borderRadius: 8,
    borderWidth: StyleSheet.hairlineWidth,
    overflow: 'hidden',
  },
  routeName: {
    color: NavOssColors.asphalt,
    fontFamily: NavOssFonts.semibold,
    fontSize: 16,
    letterSpacing: 0,
  },
  routeRow: {
    alignItems: 'center',
    backgroundColor: NavOssColors.white,
    borderBottomColor: NavOssColors.border,
    borderBottomWidth: StyleSheet.hairlineWidth,
    flexDirection: 'row',
    gap: 10,
    minHeight: 74,
    padding: 10,
  },
  rowActions: { flexDirection: 'row', gap: 5 },
  safeArea: { backgroundColor: NavOssColors.paper, flex: 1 },
  searchButton: {
    alignItems: 'center',
    backgroundColor: NavOssColors.green,
    borderRadius: 8,
    height: 48,
    justifyContent: 'center',
    width: 48,
  },
  searchInput: {
    backgroundColor: NavOssColors.white,
    borderColor: NavOssColors.border,
    borderRadius: 8,
    borderWidth: 1,
    color: NavOssColors.asphalt,
    flex: 1,
    fontFamily: NavOssFonts.regular,
    fontSize: 17,
    height: 48,
    letterSpacing: 0,
    paddingHorizontal: 14,
  },
  searchRow: { flexDirection: 'row', gap: 8 },
  sectionTitle: {
    color: NavOssColors.asphalt,
    fontFamily: NavOssFonts.bold,
    fontSize: 18,
    letterSpacing: 0,
  },
  stopMarker: {
    alignItems: 'center',
    backgroundColor: NavOssColors.asphalt,
    borderRadius: 16,
    height: 32,
    justifyContent: 'center',
    width: 32,
  },
  title: {
    color: NavOssColors.asphalt,
    fontFamily: NavOssFonts.bold,
    fontSize: 20,
    letterSpacing: 0,
  },
});
