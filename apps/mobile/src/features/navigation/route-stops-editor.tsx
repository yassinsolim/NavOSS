import type { Coordinate, SearchResult } from '@navoss/contracts';
import { SymbolView } from 'expo-symbols';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { NavOssColors, NavOssFonts } from '@/constants/navoss-theme';
import { Spacing } from '@/constants/theme';
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
  const [searchFocused, setSearchFocused] = useState(false);
  const previousVisibleRef = useRef(false);
  const originRef = useRef(origin);
  const scrollViewRef = useRef<ScrollView>(null);
  const addSectionOffsetRef = useRef(0);
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
      setSearchFocused(false);
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

  const scrollToSearchSection = useCallback(() => {
    requestAnimationFrame(() => {
      scrollViewRef.current?.scrollTo({ animated: true, y: addSectionOffsetRef.current });
    });
  }, []);

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
        <KeyboardAvoidingView
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
          keyboardVerticalOffset={0}
          style={styles.keyboardSurface}
        >
          <View style={styles.header}>
            <Pressable
              accessibilityLabel="Cancel editing stops"
              accessibilityRole="button"
              onPress={onClose}
              style={({ pressed }) => [styles.headerButton, pressed && styles.controlPressed]}
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
              accessibilityRole="button"
              accessibilityState={{ disabled: draft.length === 0 }}
              disabled={draft.length === 0}
              onPress={() => {
                onApply(draft);
              }}
              style={({ pressed }) => [
                styles.doneButton,
                draft.length === 0 && styles.buttonDisabled,
                pressed && styles.primaryPressed,
              ]}
            >
              <Text style={styles.doneText}>Done</Text>
            </Pressable>
          </View>

          <ScrollView
            contentContainerStyle={styles.content}
            keyboardDismissMode="on-drag"
            keyboardShouldPersistTaps="handled"
            onContentSizeChange={() => {
              if (searchFocused) scrollToSearchSection();
            }}
            onLayout={() => {
              if (searchFocused) {
                scrollToSearchSection();
              }
            }}
            ref={scrollViewRef}
          >
            <View style={styles.sectionHeading}>
              <Text accessibilityRole="header" style={styles.sectionTitle}>
                Route order
              </Text>
              <Text style={styles.sectionHint}>
                {draft.length === 0
                  ? 'Search below to add a destination.'
                  : 'The last place is your destination. Use the arrows to change the order.'}
              </Text>
            </View>
            <View style={styles.routeList}>
              <View style={styles.routeRow}>
                <View style={styles.originMarker}>
                  <SymbolView
                    name={{ android: 'my_location', ios: 'location.fill' }}
                    size={16}
                    tintColor={NavOssColors.paper}
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
                  <View
                    key={`${destination.id}:${String(index)}`}
                    style={[styles.routeRow, styles.editableRouteRow]}
                  >
                    <View style={styles.stopHeading}>
                      <View style={finalDestination ? styles.destinationMarker : styles.stopMarker}>
                        <Text style={styles.markerText}>
                          {finalDestination ? 'B' : String(index + 1)}
                        </Text>
                      </View>
                      <View style={styles.routeCopy}>
                        <Text style={styles.routeKind}>
                          {finalDestination ? 'DESTINATION' : `STOP ${String(index + 1)}`}
                        </Text>
                        <Text numberOfLines={2} style={styles.routeName}>
                          {destination.name}
                        </Text>
                        <Text numberOfLines={2} style={styles.routeContext}>
                          {searchResultContext(destination)}
                        </Text>
                      </View>
                    </View>
                    <View style={styles.rowActions}>
                      <Pressable
                        accessibilityLabel={`Move ${destination.name} up`}
                        accessibilityRole="button"
                        accessibilityState={{ disabled: index === 0 }}
                        disabled={index === 0}
                        onPress={() => {
                          moveDestination(index, -1);
                        }}
                        style={({ pressed }) => [
                          styles.iconButton,
                          index === 0 && styles.buttonDisabled,
                          pressed && styles.controlPressed,
                        ]}
                      >
                        <SymbolView
                          name={{ android: 'arrow_upward', ios: 'arrow.up' }}
                          size={17}
                          tintColor={NavOssColors.asphalt}
                        />
                      </Pressable>
                      <Pressable
                        accessibilityLabel={`Move ${destination.name} down`}
                        accessibilityRole="button"
                        accessibilityState={{ disabled: finalDestination }}
                        disabled={finalDestination}
                        onPress={() => {
                          moveDestination(index, 1);
                        }}
                        style={({ pressed }) => [
                          styles.iconButton,
                          finalDestination && styles.buttonDisabled,
                          pressed && styles.controlPressed,
                        ]}
                      >
                        <SymbolView
                          name={{ android: 'arrow_downward', ios: 'arrow.down' }}
                          size={17}
                          tintColor={NavOssColors.asphalt}
                        />
                      </Pressable>
                      <Pressable
                        accessibilityLabel={`Remove ${destination.name}`}
                        accessibilityRole="button"
                        accessibilityState={{ disabled: draft.length === 1 }}
                        disabled={draft.length === 1}
                        onPress={() => {
                          setDraft((current) =>
                            current.filter((_, itemIndex) => itemIndex !== index),
                          );
                        }}
                        style={({ pressed }) => [
                          styles.iconButton,
                          draft.length === 1 && styles.buttonDisabled,
                          pressed && styles.controlPressed,
                        ]}
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

            {draft.length < 9 ? (
              <View
                onLayout={(event) => {
                  addSectionOffsetRef.current = event.nativeEvent.layout.y;
                  if (searchFocused) {
                    scrollToSearchSection();
                  }
                }}
                style={styles.addSection}
              >
                <Text accessibilityRole="header" style={styles.sectionTitle}>
                  Add a stop
                </Text>
                <Text style={styles.sectionHint}>
                  New places are added to the end of your route.
                </Text>
                <View style={styles.searchRow}>
                  <TextInput
                    accessibilityLabel="Search for a stop"
                    autoCapitalize="words"
                    autoCorrect={false}
                    blurOnSubmit={false}
                    enterKeyHint="search"
                    onBlur={() => {
                      setSearchFocused(false);
                    }}
                    onFocus={() => {
                      setSearchFocused(true);
                      scrollToSearchSection();
                    }}
                    onChangeText={updateQuery}
                    onSubmitEditing={runSearch}
                    placeholder="Place name or address"
                    placeholderTextColor={NavOssColors.muted}
                    returnKeyType="search"
                    style={[styles.searchInput, searchFocused && styles.searchInputFocused]}
                    value={query}
                  />
                  <Pressable
                    accessibilityLabel="Search stops"
                    accessibilityRole="button"
                    accessibilityState={{ busy: searchState === 'loading', disabled: !canSearch }}
                    disabled={!canSearch}
                    onPress={runSearch}
                    style={({ pressed }) => [
                      styles.searchButton,
                      !canSearch && styles.buttonDisabled,
                      pressed && styles.primaryPressed,
                    ]}
                  >
                    {searchState === 'loading' ? (
                      <ActivityIndicator color={NavOssColors.paper} size="small" />
                    ) : (
                      <SymbolView
                        name={{ android: 'search', ios: 'magnifyingglass' }}
                        size={19}
                        tintColor={NavOssColors.paper}
                      />
                    )}
                  </Pressable>
                </View>
                {query.trim().length === 1 && (
                  <Text style={styles.sectionHint}>Type at least 2 characters to search.</Text>
                )}
                {showSearchResults && (
                  <View style={styles.results}>
                    {searchState === 'loading' && (
                      <View accessibilityLiveRegion="polite" style={styles.searchState}>
                        <ActivityIndicator color={NavOssColors.green} size="small" />
                        <Text style={styles.searchStateText}>Finding matching places</Text>
                      </View>
                    )}
                    {searchState === 'error' && (
                      <View
                        accessibilityLiveRegion="polite"
                        accessibilityRole="alert"
                        style={styles.searchState}
                      >
                        <Text style={styles.searchStateText}>
                          Search is unavailable right now. Try again with the search button.
                        </Text>
                      </View>
                    )}
                    {searchState === 'success' && results.length === 0 && (
                      <View accessibilityLiveRegion="polite" style={styles.searchState}>
                        <Text style={styles.searchStateText}>
                          No matches found. Try another place name or street.
                        </Text>
                      </View>
                    )}
                    {results.map((result) => {
                      const distance = formatSearchDistance(result.distanceMeters);
                      const context = searchResultContext(result);
                      return (
                        <Pressable
                          accessibilityLabel={`Add ${result.name} as a stop, ${context}${distance === undefined ? '' : `, ${distance} away`}`}
                          accessibilityRole="button"
                          key={result.id}
                          onPress={() => {
                            setDraft((current) => [...current, result]);
                            clearSearch();
                          }}
                          style={({ pressed }) => [
                            styles.resultRow,
                            pressed && styles.controlPressed,
                          ]}
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
                            <Text numberOfLines={2} style={styles.resultContext}>
                              {context}
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
            ) : (
              <Text style={styles.sectionHint}>
                Your route has 8 stops and a destination. Remove a place to add another.
              </Text>
            )}
          </ScrollView>
        </KeyboardAvoidingView>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  addSection: { gap: Spacing.two },
  addResultLabel: {
    color: NavOssColors.green,
    fontFamily: NavOssFonts.semibold,
    fontSize: 12,
    letterSpacing: 0,
  },
  buttonDisabled: { opacity: 0.4 },
  content: { gap: Spacing.four, padding: Spacing.three, paddingBottom: Spacing.five },
  controlPressed: { backgroundColor: NavOssColors.sky },
  primaryPressed: { backgroundColor: NavOssColors.asphalt },
  destinationMarker: {
    alignItems: 'center',
    backgroundColor: NavOssColors.sun,
    borderRadius: 16,
    height: 32,
    justifyContent: 'center',
    width: 32,
  },
  distance: {
    color: NavOssColors.muted,
    fontFamily: NavOssFonts.medium,
    fontSize: 14,
    letterSpacing: 0,
  },
  doneButton: {
    alignItems: 'center',
    backgroundColor: NavOssColors.green,
    borderRadius: Spacing.two,
    minHeight: 44,
    justifyContent: 'center',
    minWidth: 72,
    paddingHorizontal: Spacing.three,
  },
  doneText: {
    color: NavOssColors.paper,
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
    minHeight: Spacing.six,
    paddingHorizontal: Spacing.three,
  },
  headerButton: {
    alignItems: 'center',
    borderRadius: Spacing.four,
    height: 44,
    justifyContent: 'center',
    width: 44,
  },
  iconButton: {
    alignItems: 'center',
    backgroundColor: NavOssColors.fog,
    borderRadius: Spacing.two,
    height: 44,
    justifyContent: 'center',
    width: 44,
  },
  keyboardSurface: { flex: 1 },
  markerText: {
    color: NavOssColors.asphalt,
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
    fontSize: 14,
    letterSpacing: 0,
    lineHeight: 20,
  },
  resultCopy: { flex: 1, gap: Spacing.one, minWidth: 0 },
  resultMeta: { alignItems: 'flex-end', gap: Spacing.one },
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
    gap: Spacing.two,
    minHeight: Spacing.six,
    paddingHorizontal: Spacing.three,
    paddingVertical: Spacing.two,
  },
  results: {
    borderColor: NavOssColors.border,
    borderRadius: Spacing.two,
    borderWidth: StyleSheet.hairlineWidth,
    overflow: 'hidden',
  },
  routeContext: {
    color: NavOssColors.muted,
    fontFamily: NavOssFonts.regular,
    fontSize: 14,
    letterSpacing: 0,
    lineHeight: 20,
  },
  routeCopy: { flex: 1, gap: Spacing.one, minWidth: 0 },
  routeKind: {
    color: NavOssColors.green,
    fontFamily: NavOssFonts.bold,
    fontSize: 12,
    letterSpacing: 0,
  },
  routeList: {
    borderColor: NavOssColors.border,
    borderRadius: Spacing.two,
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
    backgroundColor: NavOssColors.paper,
    borderBottomColor: NavOssColors.border,
    borderBottomWidth: StyleSheet.hairlineWidth,
    flexDirection: 'row',
    gap: Spacing.two,
    minHeight: Spacing.six,
    padding: Spacing.three,
  },
  editableRouteRow: { alignItems: 'stretch', flexDirection: 'column' },
  stopHeading: { alignItems: 'center', flexDirection: 'row', gap: Spacing.two },
  rowActions: { flexDirection: 'row', gap: Spacing.two, justifyContent: 'flex-end' },
  safeArea: { backgroundColor: NavOssColors.paper, flex: 1 },
  searchButton: {
    alignItems: 'center',
    backgroundColor: NavOssColors.green,
    borderRadius: Spacing.two,
    height: 48,
    justifyContent: 'center',
    width: 48,
  },
  searchState: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: Spacing.two,
    minHeight: Spacing.six,
    paddingHorizontal: Spacing.three,
    paddingVertical: Spacing.three,
  },
  searchStateText: {
    color: NavOssColors.muted,
    flex: 1,
    fontFamily: NavOssFonts.medium,
    fontSize: 14,
    letterSpacing: 0,
    lineHeight: 20,
  },
  searchInput: {
    backgroundColor: NavOssColors.paper,
    borderColor: NavOssColors.border,
    borderRadius: Spacing.two,
    borderWidth: 2,
    color: NavOssColors.asphalt,
    flex: 1,
    fontFamily: NavOssFonts.regular,
    fontSize: 17,
    height: 48,
    letterSpacing: 0,
    paddingHorizontal: Spacing.three,
  },
  searchInputFocused: { borderColor: NavOssColors.green },
  searchRow: { flexDirection: 'row', gap: Spacing.two },
  sectionHeading: { gap: Spacing.two },
  sectionHint: {
    color: NavOssColors.muted,
    fontFamily: NavOssFonts.regular,
    fontSize: 14,
    lineHeight: 20,
  },
  sectionTitle: {
    color: NavOssColors.asphalt,
    fontFamily: NavOssFonts.bold,
    fontSize: 18,
    letterSpacing: 0,
  },
  stopMarker: {
    alignItems: 'center',
    backgroundColor: NavOssColors.sky,
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
