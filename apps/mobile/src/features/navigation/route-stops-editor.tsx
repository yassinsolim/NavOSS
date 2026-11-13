import type { Coordinate, SearchResult } from '@navoss/contracts';
import { SymbolView } from 'expo-symbols';
import { useCallback, useEffect, useRef, useState } from 'react';
import { StyleSheet, Text, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { createLatestRequestGate } from '@/features/map/latest-request-gate';
import { fullSheetHeight, type ScreenMetrics } from '@/features/map/overlay-layout';
import {
  formatSearchDistance,
  rankSearchResults,
  searchProximityOptions,
  searchResultContext,
} from '@/features/map/search-proximity';
import {
  MAX_ROUTE_DESTINATIONS,
  moveRouteStop,
  routeStopRole,
} from '@/features/navigation/route-stops';
import { searchPlaces } from '@/lib/api';
import { createThemedStyles, radius, space, typography, useTheme } from '@/theme';
import { haptics } from '@/theme/haptics';
import { Button } from '@/ui/button';
import { IconButton } from '@/ui/icon-button';
import { ListRow } from '@/ui/list-row';
import { BottomSheetScrollView } from '@/ui/sheet/bottom-sheet';
import { ModalSheet } from '@/ui/sheet/modal-sheet';
import { SectionTitle, SheetHeader } from '@/ui/sheet/sheet-header';
import { StateView } from '@/ui/state-view';

interface RouteStopsEditorProps {
  destinations: readonly SearchResult[];
  metrics: ScreenMetrics;
  onApply: (destinations: SearchResult[]) => void;
  onClose: () => void;
  origin?: Coordinate;
  visible: boolean;
}

type StopSearchState = 'error' | 'idle' | 'loading' | 'success';

/**
 * Edits the ordered stops of a previewed route. Changes are a draft until Done applies them;
 * closing the sheet discards them. The draft is seeded once when the sheet opens, so a parent
 * re-render with a new array identity cannot overwrite edits in progress.
 */
export function RouteStopsEditor({
  destinations,
  metrics,
  onApply,
  onClose,
  origin,
  visible,
}: RouteStopsEditorProps) {
  const { colors } = useTheme();
  const styles = useStyles();
  const insets = useSafeAreaInsets();
  const [draft, setDraft] = useState<readonly SearchResult[]>([]);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SearchResult[]>([]);
  const [searchState, setSearchState] = useState<StopSearchState>('idle');
  const [searchFocused, setSearchFocused] = useState(false);
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
  const canAddStop = draft.length < MAX_ROUTE_DESTINATIONS;

  return (
    <ModalSheet
      accessibilityLabel="Edit stops"
      detents={[fullSheetHeight(metrics)]}
      keyboardAware
      onClose={onClose}
      visible={visible}
    >
      <SheetHeader
        closeLabel="Cancel editing stops"
        onClose={onClose}
        title="Edit stops"
        trailing={
          <Button
            accessibilityLabel="Apply route stops"
            disabled={draft.length === 0}
            label="Done"
            onPress={() => {
              haptics.success();
              onApply([...draft]);
            }}
            size="sm"
          />
        }
      />
      <BottomSheetScrollView
        contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + space.xxl }]}
        keyboardDismissMode="on-drag"
      >
        {canAddStop ? (
          <View style={styles.section}>
            <SectionTitle>Add a stop</SectionTitle>
            <View style={styles.searchRow}>
              <TextInput
                accessibilityLabel="Search for a stop"
                autoCapitalize="words"
                autoCorrect={false}
                enterKeyHint="search"
                onBlur={() => {
                  setSearchFocused(false);
                }}
                onChangeText={updateQuery}
                onFocus={() => {
                  setSearchFocused(true);
                }}
                onSubmitEditing={runSearch}
                placeholder="Place name or address"
                placeholderTextColor={colors.textTertiary}
                returnKeyType="search"
                selectionColor={colors.primary}
                style={[styles.searchInput, searchFocused && styles.searchInputFocused]}
                submitBehavior="submit"
                value={query}
              />
              <IconButton
                accessibilityLabel="Search stops"
                accessibilityState={{ busy: searchState === 'loading' }}
                disabled={!canSearch}
                icon={{ android: 'search', ios: 'magnifyingglass' }}
                onPress={runSearch}
                size={50}
                variant="primary"
              />
            </View>
            <Text style={styles.hint}>
              {query.trim().length === 1
                ? 'Type at least 2 characters to search.'
                : 'New places are added to the end of your route.'}
            </Text>
            {showSearchResults && (
              <View style={styles.card}>
                {searchState === 'loading' && (
                  <StateView title="Finding matching places" visual="loading" />
                )}
                {searchState === 'error' && (
                  <StateView
                    message="Try again with the search button."
                    title="Search is unavailable right now"
                    tone="danger"
                    visual={{ android: 'wifi_off', ios: 'network.slash' }}
                  />
                )}
                {searchState === 'success' && results.length === 0 && (
                  <StateView
                    message="Try another place name or street."
                    title="No matches found"
                    visual={{ android: 'search_off', ios: 'magnifyingglass' }}
                  />
                )}
                {results.map((result) => {
                  const distance = formatSearchDistance(result.distanceMeters);
                  const context = searchResultContext(result);
                  return (
                    <ListRow
                      accessibilityLabel={`Add ${result.name} as a stop, ${context}${distance === undefined ? '' : `, ${distance} away`}`}
                      icon={{ android: 'add_location', ios: 'plus.circle.fill' }}
                      key={result.id}
                      leadingCaption={distance}
                      onPress={() => {
                        haptics.selection();
                        setDraft((current) => [...current, result]);
                        clearSearch();
                      }}
                      subtitle={context}
                      title={result.name}
                      trailing={<Text style={styles.addLabel}>Add stop</Text>}
                    />
                  );
                })}
              </View>
            )}
          </View>
        ) : (
          <Text style={styles.hint}>
            Your route has 8 stops and a destination. Remove a place to add another.
          </Text>
        )}

        <View style={styles.section}>
          <SectionTitle>Route order</SectionTitle>
          <Text style={styles.hint}>
            {draft.length === 0
              ? 'Search above to add a destination.'
              : 'The last place is your destination. Use the arrows to change the order.'}
          </Text>
          <View style={styles.card}>
            <View style={styles.stopRow}>
              <View style={[styles.marker, styles.originMarker]}>
                <SymbolView
                  name={{ android: 'my_location', ios: 'location.fill' }}
                  size={15}
                  tintColor={colors.onPrimary}
                />
              </View>
              <View style={styles.stopCopy}>
                <Text style={styles.stopKind}>Start</Text>
                <Text numberOfLines={1} style={styles.stopName}>
                  My location
                </Text>
              </View>
            </View>
            {draft.map((destination, index) => {
              const role = routeStopRole(index, draft.length);
              return (
                <View key={`${destination.id}:${String(index)}`} style={styles.stopBlock}>
                  <View style={styles.stopRow}>
                    <View
                      style={[styles.marker, role.kind === 'destination' && styles.finalMarker]}
                    >
                      <Text style={styles.markerText}>{role.marker}</Text>
                    </View>
                    <View style={styles.stopCopy}>
                      <Text style={styles.stopKind}>{role.label}</Text>
                      <Text numberOfLines={2} style={styles.stopName}>
                        {destination.name}
                      </Text>
                      <Text numberOfLines={1} style={styles.stopContext}>
                        {searchResultContext(destination)}
                      </Text>
                    </View>
                  </View>
                  <View style={styles.stopActions}>
                    <IconButton
                      accessibilityLabel={`Move ${destination.name} up`}
                      disabled={index === 0}
                      icon={{ android: 'arrow_upward', ios: 'arrow.up' }}
                      iconSize={17}
                      onPress={() => {
                        setDraft((current) => moveRouteStop(current, index, -1));
                      }}
                    />
                    <IconButton
                      accessibilityLabel={`Move ${destination.name} down`}
                      disabled={role.kind === 'destination'}
                      icon={{ android: 'arrow_downward', ios: 'arrow.down' }}
                      iconSize={17}
                      onPress={() => {
                        setDraft((current) => moveRouteStop(current, index, 1));
                      }}
                    />
                    <IconButton
                      accessibilityLabel={`Remove ${destination.name}`}
                      disabled={draft.length === 1}
                      icon={{ android: 'delete', ios: 'trash' }}
                      iconSize={17}
                      onPress={() => {
                        setDraft((current) =>
                          current.filter((_, itemIndex) => itemIndex !== index),
                        );
                      }}
                      tintColor={colors.dangerText}
                    />
                  </View>
                </View>
              );
            })}
          </View>
        </View>
      </BottomSheetScrollView>
    </ModalSheet>
  );
}

const useStyles = createThemedStyles(({ colors }) =>
  StyleSheet.create({
    addLabel: { ...typography.footnoteStrong, color: colors.primaryText },
    card: {
      backgroundColor: colors.surfaceSunken,
      borderCurve: 'continuous',
      borderRadius: radius.lg,
      padding: space.xs,
    },
    content: { gap: space.xl, paddingHorizontal: space.lg },
    finalMarker: { backgroundColor: colors.danger },
    hint: { ...typography.footnote, color: colors.textSecondary },
    marker: {
      alignItems: 'center',
      backgroundColor: colors.text,
      borderRadius: radius.pill,
      height: 30,
      justifyContent: 'center',
      width: 30,
    },
    markerText: { ...typography.footnoteStrong, color: colors.surface },
    originMarker: { backgroundColor: colors.primary },
    searchInput: {
      ...typography.body,
      backgroundColor: colors.surfaceSunken,
      borderColor: 'transparent',
      borderCurve: 'continuous',
      borderRadius: radius.md,
      borderWidth: 1.5,
      color: colors.text,
      flex: 1,
      height: 50,
      lineHeight: undefined,
      paddingHorizontal: space.md,
      paddingVertical: 0,
    },
    searchInputFocused: { borderColor: colors.primary },
    searchRow: { alignItems: 'center', flexDirection: 'row', gap: space.sm },
    section: { gap: space.sm },
    stopActions: {
      flexDirection: 'row',
      gap: space.sm,
      justifyContent: 'flex-end',
      paddingBottom: space.sm,
      paddingRight: space.sm,
    },
    stopBlock: {
      borderTopColor: colors.border,
      borderTopWidth: StyleSheet.hairlineWidth,
    },
    stopContext: { ...typography.footnote, color: colors.textSecondary },
    stopCopy: { flex: 1, gap: 1 },
    stopKind: { ...typography.eyebrow, color: colors.textTertiary, fontSize: 11 },
    stopName: { ...typography.bodyStrong, color: colors.text },
    stopRow: { alignItems: 'center', flexDirection: 'row', gap: space.md, padding: space.sm },
  }),
);
