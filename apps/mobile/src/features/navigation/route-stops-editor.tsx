import type { Coordinate, SearchResult } from '@navoss/contracts';
import { SymbolView } from 'expo-symbols';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
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
import { createLatestRequestGate } from '@/features/map/latest-request-gate';
import { searchPlaces } from '@/lib/api';

interface RouteStopsEditorProps {
  destinations: readonly SearchResult[];
  onApply: (destinations: SearchResult[]) => void;
  onClose: () => void;
  origin?: Coordinate;
  visible: boolean;
}

type StopSearchState = 'error' | 'idle' | 'loading' | 'success';

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
  const [searchState, setSearchState] = useState<StopSearchState>('idle');
  const previousVisibleRef = useRef(false);
  const originRef = useRef(origin);
  const [searchRequestGate] = useState(createLatestRequestGate);

  useEffect(() => {
    originRef.current = origin;
  }, [origin]);

  const completeSearch = useCallback(
    async (normalizedQuery: string, requestGeneration: number) => {
      try {
        const response = await searchPlaces(
          normalizedQuery,
          searchProximityOptions(originRef.current),
        );
        if (!searchRequestGate.isCurrent(requestGeneration)) return;
        setResults(rankSearchResults(response.results, [], originRef.current));
        setSearchState('success');
      } catch {
        if (!searchRequestGate.isCurrent(requestGeneration)) return;
        setResults([]);
        setSearchState('error');
      }
    },
    [searchRequestGate],
  );

  useEffect(() => {
    if (visible && !previousVisibleRef.current) {
      searchRequestGate.advance();
      setDraft([...destinations]);
      setQuery('');
      setResults([]);
      setSearchState('idle');
    }
    previousVisibleRef.current = visible;
  }, [destinations, searchRequestGate, visible]);

  useEffect(() => {
    const normalizedQuery = query.trim();
    const requestGeneration = searchRequestGate.advance();
    if (!visible || normalizedQuery.length < 2) {
      if (visible) {
        setResults([]);
        setSearchState('idle');
      }
      return;
    }

    setResults([]);
    setSearchState('loading');
    const timeout = setTimeout(() => {
      void completeSearch(normalizedQuery, requestGeneration);
    }, 250);
    return () => {
      clearTimeout(timeout);
    };
  }, [completeSearch, query, searchRequestGate, visible]);

  const updateQuery = (nextQuery: string) => {
    searchRequestGate.advance();
    setQuery(nextQuery);
  };

  const clearSearch = () => {
    searchRequestGate.advance();
    setQuery('');
    setResults([]);
    setSearchState('idle');
  };

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

  const runSearch = () => {
    const normalizedQuery = query.trim();
    if (normalizedQuery.length < 2) return;
    const requestGeneration = searchRequestGate.advance();
    setResults([]);
    setSearchState('loading');
    void completeSearch(normalizedQuery, requestGeneration);
  };

  const canSearch = query.trim().length >= 2;
  const showSearchResults = canSearch && searchState !== 'idle';

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
                  autoCorrect={false}
                  blurOnSubmit={false}
                  enterKeyHint="search"
                  onChangeText={updateQuery}
                  onSubmitEditing={runSearch}
                  placeholder="Search places"
                  placeholderTextColor={NavOssColors.muted}
                  returnKeyType="search"
                  style={styles.searchInput}
                  value={query}
                />
                <Pressable
                  accessibilityLabel="Search stops"
                  disabled={!canSearch}
                  onPress={runSearch}
                  style={[styles.searchButton, !canSearch && styles.buttonDisabled]}
                >
                  {searchState === 'loading' ? (
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
              {showSearchResults && (
                <View style={styles.results}>
                  {searchState === 'loading' && (
                    <View style={styles.searchState}>
                      <ActivityIndicator color={NavOssColors.green} size="small" />
                      <Text style={styles.searchStateText}>Searching places</Text>
                    </View>
                  )}
                  {searchState === 'error' && (
                    <View style={styles.searchState}>
                      <Text style={styles.searchStateText}>Search service unavailable</Text>
                    </View>
                  )}
                  {searchState === 'success' && results.length === 0 && (
                    <View style={styles.searchState}>
                      <Text style={styles.searchStateText}>No places found</Text>
                    </View>
                  )}
                  {results.map((result) => {
                    const distance = formatSearchDistance(result.distanceMeters);
                    return (
                      <Pressable
                        accessibilityLabel={`Add ${result.name} as a stop`}
                        key={result.id}
                        onPress={() => {
                          setDraft((current) => [...current, result]);
                          clearSearch();
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
                        <View style={styles.resultMeta}>
                          {distance !== undefined && (
                            <Text style={styles.distance}>{distance}</Text>
                          )}
                          <Text style={styles.addResultLabel}>Add stop</Text>
                        </View>
                      </Pressable>
                    );
                  })}
                </View>
              )}
            </View>
          )}
        </ScrollView>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  addSection: { gap: 12 },
  addResultLabel: {
    color: NavOssColors.green,
    fontFamily: NavOssFonts.semibold,
    fontSize: 12,
    letterSpacing: 0,
  },
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
  resultMeta: { alignItems: 'flex-end', gap: 2 },
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
  searchState: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 8,
    minHeight: 62,
    paddingHorizontal: 14,
    paddingVertical: 8,
  },
  searchStateText: {
    color: NavOssColors.muted,
    fontFamily: NavOssFonts.medium,
    fontSize: 14,
    letterSpacing: 0,
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
