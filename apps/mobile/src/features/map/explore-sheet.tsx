import type { SearchResult, SearchSource } from '@navoss/contracts';
import { SymbolView } from 'expo-symbols';
import { type RefObject, useMemo, useState } from 'react';
import {
  Keyboard,
  Linking,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  useWindowDimensions,
  View,
} from 'react-native';
import type { SharedValue } from 'react-native-reanimated';

import type { SearchState } from '@/features/map/controller/use-place-search';
import { type ExploreCategory, QUICK_EXPLORE_CATEGORIES } from '@/features/map/explore-categories';
import {
  exploreSheetDetents,
  type ScreenMetrics,
  TAB_BAR_HEIGHT,
} from '@/features/map/overlay-layout';
import { formatSearchDistance, groupRecentSearchResults } from '@/features/map/search-proximity';
import { categoryLabel, searchResultSubtitle } from '@/features/map/search-result-category';
import {
  type ApiConnectionState,
  exploreServiceNotice,
  searchSourceLabel,
} from '@/features/map/search-status';
import {
  type NativeDestinationCatalog,
  nativeDestinationToSearchResult,
} from '@/features/navigation/native-navigation';
import { useOfflineMapsInstalled } from '@/features/offline/offline-maps';
import { useRenderCounter } from '@/lib/render-counter';
import { createThemedStyles, radius, space, typography, useTheme } from '@/theme';
import { haptics } from '@/theme/haptics';
import { Banner } from '@/ui/banner';
import { Button } from '@/ui/button';
import { Chip } from '@/ui/chip';
import { IconButton } from '@/ui/icon-button';
import { ListRow } from '@/ui/list-row';
import { BottomSheet, type BottomSheetRef, BottomSheetScrollView } from '@/ui/sheet/bottom-sheet';
import { SectionTitle } from '@/ui/sheet/sheet-header';
import { StateView } from '@/ui/state-view';

const NO_RECENT_DESTINATIONS: readonly string[] = [];

export interface ExploreSheetProps {
  apiConnection: ApiConnectionState;
  catalog: NativeDestinationCatalog;
  /** The server's declared coverage name. */
  coverageName: string;
  locationState: 'denied' | 'error' | 'idle' | 'locating' | 'visible';
  metrics: ScreenMetrics;
  nearbySearchEnabled: boolean;
  onCategoryPress: (category: ExploreCategory) => void;
  onChangeQuery: (query: string) => void;
  onChooseSavedPlace: (place: SearchResult) => void;
  onClear: () => void;
  onOpenMoreCategories: () => void;
  onSelectResult: (result: SearchResult) => void;
  onShortcutPress: (shortcut: 'home' | 'work') => void;
  onSubmit: () => void;
  position: SharedValue<number>;
  query: string;
  results: SearchResult[];
  resultsDegraded: boolean;
  searchSource: SearchSource | undefined;
  searchState: SearchState;
  selectedCategoryId: string | undefined;
  sheetRef: RefObject<BottomSheetRef | null>;
  shortcutBeingSet: 'home' | 'work' | undefined;
}

interface ResultSection {
  data: readonly SearchResult[];
  key: string;
  recent: boolean;
  title: string | undefined;
}

/**
 * The resting surface of the app: search, nearby categories, and the driver's own places, in a
 * sheet that sits on the tab bar. Collapsed it is a search field over the map; typing raises it
 * to full height above the keyboard; submitting drops it back so results can be read on the map.
 */
export function ExploreSheet({
  apiConnection,
  catalog,
  coverageName,
  locationState,
  metrics,
  nearbySearchEnabled,
  onCategoryPress,
  onChangeQuery,
  onChooseSavedPlace,
  onClear,
  onOpenMoreCategories,
  onSelectResult,
  onShortcutPress,
  onSubmit,
  position,
  query,
  results,
  resultsDegraded,
  searchSource,
  searchState,
  selectedCategoryId,
  sheetRef,
  shortcutBeingSet,
}: ExploreSheetProps) {
  useRenderCounter('ExploreSheet');
  const { colors } = useTheme();
  const styles = useStyles();
  // iOS keeps text measured at the old size when Dynamic Type changes while the app is open
  // ("Home" drawn as "Ho…"). Keying the chip row on the font scale makes it measure again.
  const { fontScale } = useWindowDimensions();
  const detents = exploreSheetDetents(metrics);
  const [detentIndex, setDetentIndex] = useState(detents.initial);
  const [focused, setFocused] = useState(false);
  const activeCategoryLabel = selectedCategoryId === undefined ? undefined : query;
  const recentDestinationIds = useMemo(
    () => catalog.recents.map((destination) => destination.id),
    [catalog.recents],
  );
  const sections = useMemo<ResultSection[]>(() => {
    const { recentMatches, remainingResults } = groupRecentSearchResults(
      results,
      activeCategoryLabel === undefined ? recentDestinationIds : NO_RECENT_DESTINATIONS,
    );
    if (recentMatches.length === 0) {
      return [{ data: remainingResults, key: 'results', recent: false, title: undefined }];
    }
    return [
      { data: recentMatches, key: 'recent', recent: true, title: 'Recent matches' },
      ...(remainingResults.length === 0
        ? []
        : [{ data: remainingResults, key: 'results', recent: false, title: 'More matches' }]),
    ];
  }, [activeCategoryLabel, recentDestinationIds, results]);
  const favorites = useMemo(
    () => catalog.favorites.map(nativeDestinationToSearchResult),
    [catalog.favorites],
  );
  const recents = useMemo(
    () => catalog.recents.map(nativeDestinationToSearchResult),
    [catalog.recents],
  );
  const showResults = query.trim().length >= 2 && (searchState !== 'idle' || results.length > 0);
  const listExpanded = detentIndex > 0;
  const offlineMapsInstalled = useOfflineMapsInstalled();
  const notice = exploreServiceNotice({
    apiConnection,
    coverageName,
    locationState,
    nearbySearchEnabled,
    offlineMapsInstalled,
  });

  return (
    <BottomSheet
      bottomOffset={TAB_BAR_HEIGHT + metrics.bottomInset}
      detents={detents.values}
      initialDetent={detents.initial}
      keyboardAware
      onDetentChange={setDetentIndex}
      position={position}
      ref={sheetRef}
      restsImmediately
    >
      <View style={styles.searchRow}>
        <View style={[styles.searchField, focused && styles.searchFieldFocused]}>
          <SymbolView
            name={{ android: 'search', ios: 'magnifyingglass' }}
            size={20}
            tintColor={colors.textSecondary}
          />
          <TextInput
            accessibilityLabel="Search places"
            autoCapitalize="words"
            autoCorrect={false}
            enterKeyHint="search"
            onBlur={() => {
              setFocused(false);
            }}
            onChangeText={onChangeQuery}
            onFocus={() => {
              setFocused(true);
              sheetRef.current?.snapTo(detents.values.length - 1);
            }}
            onSubmitEditing={() => {
              Keyboard.dismiss();
              onSubmit();
            }}
            placeholder={
              shortcutBeingSet === undefined
                ? 'Where to?'
                : `Search to set ${shortcutBeingSet === 'home' ? 'Home' : 'Work'}`
            }
            placeholderTextColor={colors.textTertiary}
            returnKeyType="search"
            selectionColor={colors.primary}
            style={styles.input}
            value={query}
          />
          {(query.length > 0 || shortcutBeingSet !== undefined) && (
            <IconButton
              accessibilityLabel="Clear search"
              icon={{ android: 'close', ios: 'xmark.circle.fill' }}
              iconSize={18}
              onPress={onClear}
              tintColor={colors.textTertiary}
              variant="plain"
            />
          )}
        </View>
        {!showResults && !focused && (
          <IconButton
            accessibilityLabel="More categories"
            icon={{ android: 'apps', ios: 'square.grid.2x2.fill' }}
            onPress={onOpenMoreCategories}
            size={50}
            tintColor={colors.primaryText}
          />
        )}
      </View>

      {showResults ? (
        <>
          {results.length > 0 && (
            <View style={styles.resultsHeader}>
              <Text
                maxFontSizeMultiplier={1.4}
                accessibilityRole="header"
                style={styles.resultsCount}
              >
                {results.length} {results.length === 1 ? 'place' : 'places'} found
              </Text>
              <Button
                accessibilityHint={
                  listExpanded
                    ? 'Collapse the list to explore matching locations on the map'
                    : 'Browse matching places and their distances'
                }
                accessibilityLabel={listExpanded ? 'Show map' : 'Show list'}
                accessibilityState={{ expanded: listExpanded }}
                icon={
                  listExpanded
                    ? { android: 'map', ios: 'map' }
                    : { android: 'list', ios: 'list.bullet' }
                }
                label={listExpanded ? 'Show map' : 'Show list'}
                onPress={() => {
                  Keyboard.dismiss();
                  haptics.selection();
                  sheetRef.current?.snapTo(listExpanded ? 0 : 1);
                }}
                size="sm"
                variant="tonal"
              />
            </View>
          )}
          <BottomSheetScrollView contentContainerStyle={styles.listContent}>
            {searchState === 'loading' && (
              <StateView
                title={
                  activeCategoryLabel === undefined ? 'Searching places' : 'Finding nearby places'
                }
                visual="loading"
              />
            )}
            {searchState === 'error' && (
              <StateView
                message="Please try your search again in a moment."
                title="Search is unavailable right now"
                tone="danger"
                visual={{ android: 'wifi_off', ios: 'network.slash' }}
              />
            )}
            {searchState === 'success' && results.length === 0 && (
              <StateView
                layout="block"
                message={
                  activeCategoryLabel === undefined
                    ? 'Try another place name or add a street.'
                    : 'Try another category or search by name.'
                }
                title={
                  activeCategoryLabel === undefined ? 'No matches found' : 'No places found nearby'
                }
                visual={{ android: 'search_off', ios: 'magnifyingglass' }}
              />
            )}
            {results.length > 0 &&
              sections.map((section) => (
                <View key={section.key}>
                  {section.title !== undefined && <SectionTitle>{section.title}</SectionTitle>}
                  {section.data.map((item) => {
                    const distance = formatSearchDistance(item.distanceMeters);
                    const context = searchResultSubtitle(item);
                    const badge = categoryLabel(item, activeCategoryLabel);
                    return (
                      <ListRow
                        accessibilityHint={
                          section.recent
                            ? 'Recently used destination matching this search'
                            : undefined
                        }
                        accessibilityLabel={`Select ${item.name}${badge === '' ? '' : `, ${badge}`}${distance === undefined ? '' : `, ${distance} away`}, ${context}`}
                        icon={
                          section.recent
                            ? { android: 'history', ios: 'clock.arrow.circlepath' }
                            : { android: 'location_on', ios: 'mappin' }
                        }
                        iconTint={section.recent ? colors.primaryText : colors.danger}
                        key={item.id}
                        leadingCaption={distance}
                        onPress={() => {
                          onSelectResult(item);
                        }}
                        subtitle={context}
                        title={item.name}
                        trailing={
                          badge === '' ? undefined : (
                            <Text maxFontSizeMultiplier={1.4} style={styles.badge}>
                              {badge}
                            </Text>
                          )
                        }
                      />
                    );
                  })}
                </View>
              ))}
            <Text maxFontSizeMultiplier={1.4} style={styles.source}>
              {searchSourceLabel(searchSource, resultsDegraded)}
            </Text>
          </BottomSheetScrollView>
        </>
      ) : (
        <>
          <ScrollView
            key={String(fontScale)}
            accessibilityLabel="Explore nearby"
            contentContainerStyle={styles.chips}
            horizontal
            keyboardShouldPersistTaps="handled"
            showsHorizontalScrollIndicator={false}
            style={styles.chipScroller}
          >
            {(['home', 'work'] as const).map((shortcut) => {
              const saved = catalog[shortcut] !== undefined;
              const label = shortcut === 'home' ? 'Home' : 'Work';
              return (
                <Chip
                  accessibilityHint={
                    saved ? `Opens your saved ${label} place` : `Starts ${label} setup`
                  }
                  accessibilityLabel={saved ? label : `Set up ${label}`}
                  icon={
                    shortcut === 'home'
                      ? { android: 'home', ios: saved ? 'house.fill' : 'house' }
                      : { android: 'work', ios: saved ? 'briefcase.fill' : 'briefcase' }
                  }
                  key={shortcut}
                  label={label}
                  onPress={() => {
                    onShortcutPress(shortcut);
                  }}
                  selected={shortcutBeingSet === shortcut}
                />
              );
            })}
            {QUICK_EXPLORE_CATEGORIES.map((category) => (
              <Chip
                accessibilityLabel={`Find ${category.label}`}
                icon={category.icon}
                key={category.id}
                label={category.label}
                onPress={() => {
                  onCategoryPress(category);
                }}
                selected={selectedCategoryId === category.id}
              />
            ))}
          </ScrollView>
          <BottomSheetScrollView contentContainerStyle={styles.listContent}>
            {notice !== undefined && (
              <Banner
                action={
                  locationState === 'denied' && apiConnection !== 'offline' ? (
                    <Pressable
                      accessibilityLabel="Open Settings"
                      accessibilityRole="button"
                      hitSlop={12}
                      onPress={() => {
                        void Linking.openSettings();
                      }}
                    >
                      <Text style={styles.bannerAction}>Settings</Text>
                    </Pressable>
                  ) : undefined
                }
                announce
                message={notice.message}
                style={styles.notice}
                title={notice.title}
                tone={notice.tone}
              />
            )}
            {shortcutBeingSet !== undefined && (
              <Banner
                message={`Search for a place, then choose it to save it as ${shortcutBeingSet === 'home' ? 'Home' : 'Work'} on this device.`}
                style={styles.notice}
                title={`Setting ${shortcutBeingSet === 'home' ? 'Home' : 'Work'}`}
              />
            )}
            {favorites.length > 0 && (
              <View style={styles.section}>
                <SectionTitle>Favourites</SectionTitle>
                {favorites.map((place) => (
                  <ListRow
                    accessibilityLabel={`${place.name}, ${place.label}`}
                    icon={{ android: 'bookmark', ios: 'bookmark.fill' }}
                    key={place.id}
                    onPress={() => {
                      onChooseSavedPlace(place);
                    }}
                    subtitle={searchResultSubtitle(place)}
                    subtitleLines={1}
                    title={place.name}
                  />
                ))}
              </View>
            )}
            {recents.length > 0 && (
              <View style={styles.section}>
                <SectionTitle>Recent</SectionTitle>
                {recents.map((place) => (
                  <ListRow
                    accessibilityLabel={`${place.name}, ${place.label}`}
                    icon={{ android: 'history', ios: 'clock.arrow.circlepath' }}
                    iconTint={colors.textSecondary}
                    key={place.id}
                    onPress={() => {
                      onChooseSavedPlace(place);
                    }}
                    subtitle={searchResultSubtitle(place)}
                    subtitleLines={1}
                    title={place.name}
                  />
                ))}
              </View>
            )}
            {favorites.length === 0 && recents.length === 0 && (
              <StateView
                layout="block"
                message="Places you save and destinations you navigate to appear here. They stay on this device."
                title="No saved or recent places yet"
                visual={{ android: 'bookmark_border', ios: 'bookmark' }}
              />
            )}
          </BottomSheetScrollView>
        </>
      )}
    </BottomSheet>
  );
}

const useStyles = createThemedStyles(({ colors }) =>
  StyleSheet.create({
    badge: {
      ...typography.caption,
      color: colors.textSecondary,
      maxWidth: 96,
      textAlign: 'right',
      textTransform: 'capitalize',
    },
    bannerAction: { ...typography.label, color: colors.primaryText },
    chipScroller: { flexGrow: 0 },
    chips: { gap: space.sm, paddingBottom: space.md, paddingHorizontal: space.lg },
    input: {
      ...typography.body,
      color: colors.text,
      flex: 1,
      fontSize: 17,
      height: 50,
      lineHeight: undefined,
      paddingVertical: 0,
    },
    listContent: { gap: space.xs, paddingBottom: space.xxl, paddingHorizontal: space.md },
    notice: { marginBottom: space.sm, marginHorizontal: space.xs },
    resultsCount: { ...typography.label, color: colors.text },
    resultsHeader: {
      alignItems: 'center',
      flexDirection: 'row',
      height: 44,
      justifyContent: 'space-between',
      marginBottom: space.md,
      paddingHorizontal: space.lg,
    },
    searchField: {
      alignItems: 'center',
      backgroundColor: colors.surfaceSunken,
      borderColor: 'transparent',
      borderCurve: 'continuous',
      borderRadius: radius.lg,
      borderWidth: 1.5,
      flex: 1,
      flexDirection: 'row',
      gap: space.sm,
      paddingLeft: space.md,
    },
    searchFieldFocused: { borderColor: colors.primary },
    searchRow: {
      flexDirection: 'row',
      gap: space.sm,
      paddingBottom: space.md,
      paddingHorizontal: space.lg,
      paddingTop: space.xs,
    },
    section: { gap: space.xs, paddingHorizontal: space.xs, paddingTop: space.sm },
    source: {
      ...typography.caption,
      color: colors.textTertiary,
      paddingHorizontal: space.sm,
      paddingTop: space.md,
    },
  }),
);
