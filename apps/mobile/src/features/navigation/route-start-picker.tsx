import type { SearchResult } from '@navoss/contracts';
import { useCallback, useEffect, useRef, useState } from 'react';
import { StyleSheet, Text, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { createLatestRequestGate } from '@/features/map/latest-request-gate';
import { fullSheetHeight, type ScreenMetrics } from '@/features/map/overlay-layout';
import {
  rankSearchResults,
  searchProximityOptions,
  searchResultContext,
} from '@/features/map/search-proximity';
import { savedRouteStarts } from '@/features/navigation/route-start';
import { searchPlaces } from '@/lib/api';
import { createThemedStyles, radius, space, typography, useTheme } from '@/theme';
import { haptics } from '@/theme/haptics';
import { IconButton } from '@/ui/icon-button';
import { ListRow } from '@/ui/list-row';
import { BottomSheetScrollView } from '@/ui/sheet/bottom-sheet';
import { ModalSheet } from '@/ui/sheet/modal-sheet';
import { SectionTitle, SheetHeader } from '@/ui/sheet/sheet-header';
import { StateView } from '@/ui/state-view';

import type { NativeDestinationCatalog } from '../../../modules/navoss-navigation';

type StartSearchState = 'error' | 'idle' | 'loading' | 'success';

interface RouteStartPickerProps {
  catalog: NativeDestinationCatalog;
  destination: SearchResult;
  metrics: ScreenMetrics;
  onChoose: (start: SearchResult) => void;
  onClose: () => void;
  visible: boolean;
}

/**
 * Chooses where a route preview starts when the device's location cannot (no GPS radio, location
 * off or denied): a saved place or a searched one. The route is planned from there and, like the
 * supported-route demo, can be previewed but not started; live guidance needs the real location.
 */
export function RouteStartPicker({
  catalog,
  destination,
  metrics,
  onChoose,
  onClose,
  visible,
}: RouteStartPickerProps) {
  const { colors } = useTheme();
  const styles = useStyles();
  const insets = useSafeAreaInsets();
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SearchResult[]>([]);
  const [searchState, setSearchState] = useState<StartSearchState>('idle');
  const [searchFocused, setSearchFocused] = useState(false);
  const previousVisibleRef = useRef(false);
  const [searchRequestGate] = useState(createLatestRequestGate);
  const destinationCenter = destination.center;
  const destinationId = destination.id;

  const completeSearch = useCallback(
    async (normalizedQuery: string, requestGeneration: number) => {
      try {
        // Searched near the destination: with no location fix it is the best hint of the area.
        const response = await searchPlaces(
          normalizedQuery,
          searchProximityOptions(destinationCenter),
        );
        if (!searchRequestGate.isCurrent(requestGeneration)) return;
        setResults(
          rankSearchResults(response.results, []).filter((result) => result.id !== destinationId),
        );
        setSearchState('success');
      } catch {
        if (!searchRequestGate.isCurrent(requestGeneration)) return;
        setResults([]);
        setSearchState('error');
      }
    },
    [destinationCenter, destinationId, searchRequestGate],
  );

  useEffect(() => {
    if (visible && !previousVisibleRef.current) {
      searchRequestGate.advance();
      setQuery('');
      setResults([]);
      setSearchState('idle');
      setSearchFocused(false);
    }
    previousVisibleRef.current = visible;
  }, [searchRequestGate, visible]);

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

  const runSearch = () => {
    const normalizedQuery = query.trim();
    if (normalizedQuery.length < 2) return;
    const requestGeneration = searchRequestGate.advance();
    setResults([]);
    setSearchState('loading');
    void completeSearch(normalizedQuery, requestGeneration);
  };

  const choose = (start: SearchResult) => {
    haptics.selection();
    onChoose(start);
  };

  const canSearch = query.trim().length >= 2;
  const savedStarts = savedRouteStarts(catalog, destinationId);

  return (
    <ModalSheet
      accessibilityLabel="Choose a start"
      detents={[fullSheetHeight(metrics)]}
      keyboardAware
      onClose={onClose}
      visible={visible}
    >
      <SheetHeader
        closeLabel="Cancel choosing a start"
        eyebrow={`Route to ${destination.name}`}
        onClose={onClose}
        title="Choose a start"
      />
      <BottomSheetScrollView
        contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + space.xxl }]}
        keyboardDismissMode="on-drag"
      >
        <Text maxFontSizeMultiplier={1.5} style={styles.hint}>
          The route is previewed from the place you choose. Live guidance needs your real location.
        </Text>
        <View style={styles.section}>
          <SectionTitle>Search</SectionTitle>
          <View style={styles.searchRow}>
            <TextInput
              disableFullscreenUI
              // The field is one line of fixed height: the largest text sizes cut the placeholder.
              maxFontSizeMultiplier={1.4}
              accessibilityLabel="Search for a start"
              autoCapitalize="words"
              autoCorrect={false}
              enterKeyHint="search"
              onBlur={() => {
                setSearchFocused(false);
              }}
              onChangeText={(nextQuery) => {
                searchRequestGate.advance();
                setQuery(nextQuery);
              }}
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
              accessibilityLabel="Search starts"
              accessibilityState={{ busy: searchState === 'loading' }}
              disabled={!canSearch}
              icon={{ android: 'search', ios: 'magnifyingglass' }}
              onPress={runSearch}
              size={50}
              variant="primary"
            />
          </View>
          {query.trim().length === 1 && (
            <Text maxFontSizeMultiplier={1.5} style={styles.hint}>
              Type at least 2 characters to search.
            </Text>
          )}
          {canSearch && searchState !== 'idle' && (
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
                const context = searchResultContext(result);
                return (
                  <ListRow
                    accessibilityLabel={`Start from ${result.name}, ${context}`}
                    icon={{ android: 'location_on', ios: 'mappin' }}
                    key={result.id}
                    onPress={() => {
                      choose(result);
                    }}
                    subtitle={context}
                    title={result.name}
                    trailing="chevron"
                  />
                );
              })}
            </View>
          )}
        </View>
        {savedStarts.length > 0 && (
          <View style={styles.section}>
            <SectionTitle>Saved and recent</SectionTitle>
            <View style={styles.card}>
              {savedStarts.map(({ kind, place }) => (
                <ListRow
                  accessibilityLabel={`Start from ${kind === 'Home' || kind === 'Work' ? `${kind}, ` : ''}${place.name}`}
                  eyebrow={kind}
                  icon={
                    kind === 'Home'
                      ? { android: 'home', ios: 'house.fill' }
                      : kind === 'Work'
                        ? { android: 'work', ios: 'briefcase.fill' }
                        : kind === 'Saved'
                          ? { android: 'bookmark', ios: 'bookmark.fill' }
                          : { android: 'history', ios: 'clock.arrow.circlepath' }
                  }
                  key={place.id}
                  onPress={() => {
                    choose(place);
                  }}
                  subtitle={searchResultContext(place)}
                  title={place.name}
                  trailing="chevron"
                />
              ))}
            </View>
          </View>
        )}
      </BottomSheetScrollView>
    </ModalSheet>
  );
}

const useStyles = createThemedStyles(({ colors }) =>
  StyleSheet.create({
    card: {
      backgroundColor: colors.surfaceSunken,
      borderCurve: 'continuous',
      borderRadius: radius.lg,
      padding: space.xs,
    },
    content: { gap: space.xl, paddingHorizontal: space.lg },
    hint: { ...typography.footnote, color: colors.textSecondary },
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
  }),
);
