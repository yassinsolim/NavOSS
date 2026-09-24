import type { SearchResult, SearchSource } from '@navoss/contracts';
import { SymbolView } from 'expo-symbols';
import {
  ActivityIndicator,
  SectionList,
  Image,
  Keyboard,
  Linking,
  Modal,
  Pressable,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { type ReactNode, useMemo, useState } from 'react';
import Animated, {
  FadeIn,
  FadeInDown,
  FadeOut,
  FadeOutUp,
  LinearTransition,
  ReduceMotion,
  interpolate,
  interpolateColor,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';

import { NavOssColors, NavOssFonts } from '@/constants/navoss-theme';
import { Spacing } from '@/constants/theme';
import { categoryLabel } from '@/features/map/search-result-category';
import {
  formatSearchDistance,
  groupRecentSearchResults,
  searchResultContext,
} from '@/features/map/search-proximity';
import { getGooglePlacesOpenSourceLicenseInfo } from '@/features/navigation/native-navigation';

const PRIVACY_POLICY_URL = 'https://navoss.yassin.app/privacy';
const SUPPORT_URL = 'https://navoss.yassin.app/support';
const NO_RECENT_DESTINATIONS: readonly string[] = [];

export type ApiConnectionState = 'connecting' | 'online' | 'offline';
export type SearchState = 'idle' | 'loading' | 'success' | 'error';

interface SearchPanelProps {
  activeCategoryLabel?: string;
  apiConnection: ApiConnectionState;
  coverageName: string;
  darkMap: boolean;
  discoveryActions?: ReactNode;
  maximumResultsHeight: number;
  onChangeQuery: (query: string) => void;
  onClear: () => void;
  onClearDestinationHistory: () => void;
  onSelectResult: (result: SearchResult) => void;
  onSubmit: () => void;
  query: string;
  recentDestinationIds?: readonly string[];
  results: SearchResult[];
  searchEnabled?: boolean;
  searchPlaceholder?: string;
  searchSource: SearchSource | undefined;
  searchState: SearchState;
}

interface SearchResultSection {
  data: readonly SearchResult[];
  key: string;
  recent: boolean;
  title: string | undefined;
}

function connectionLabel(state: ApiConnectionState): string {
  if (state === 'offline') {
    return 'Service unavailable';
  }

  if (state === 'connecting') {
    return 'Connecting';
  }

  return 'Service online';
}

function searchSourceLabel(source: SearchSource | undefined): string {
  if (source === undefined) {
    return 'Calgary place search';
  }

  if (source.id === 'calgary-hybrid-search' || source.id === 'calgary-open-data-index') {
    return 'Calgary Open Data + OpenStreetMap';
  }

  return source.freshness === 'static'
    ? 'Calgary place data · Not live'
    : source.id === 'nominatim-self-hosted'
      ? 'OpenStreetMap search'
      : 'OpenStreetMap search · Preview data';
}

export function SearchPanel({
  activeCategoryLabel,
  apiConnection,
  coverageName,
  darkMap,
  discoveryActions,
  maximumResultsHeight,
  onChangeQuery,
  onClear,
  onClearDestinationHistory,
  onSelectResult,
  onSubmit,
  query,
  recentDestinationIds = NO_RECENT_DESTINATIONS,
  results,
  searchEnabled = true,
  searchPlaceholder = 'Where to?',
  searchSource,
  searchState,
}: SearchPanelProps) {
  const [isAboutVisible, setIsAboutVisible] = useState(false);
  const [isGoogleLicensesVisible, setIsGoogleLicensesVisible] = useState(false);
  const [googlePlacesLicenseInfo] = useState(() => getGooglePlacesOpenSourceLicenseInfo());
  const [resultsExpanded, setResultsExpanded] = useState(true);
  const resultSections = useMemo<SearchResultSection[]>(() => {
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
  const searchFocus = useSharedValue(0);
  const animatedSearchBarStyle = useAnimatedStyle(() => ({
    borderColor: interpolateColor(
      searchFocus.value,
      [0, 1],
      [NavOssColors.border, NavOssColors.green],
    ),
    shadowOpacity: interpolate(searchFocus.value, [0, 1], [0.1, 0.16]),
  }));
  const showResults = query.trim().length >= 2 && (searchState !== 'idle' || results.length > 0);
  const connectionColor =
    apiConnection === 'online'
      ? NavOssColors.green
      : apiConnection === 'offline'
        ? NavOssColors.coral
        : NavOssColors.sun;

  return (
    <View pointerEvents="box-none" style={styles.container}>
      <View style={styles.brandRow}>
        <Image
          accessibilityIgnoresInvertColors
          accessible={false}
          source={require('@/assets/images/icon.png')}
          style={styles.brandMark}
        />
        <Text style={[styles.brandName, darkMap && styles.brandNameDark]}>NavOSS</Text>
        <View accessibilityLiveRegion="polite" style={styles.connectionStatus}>
          <View style={[styles.connectionDot, { backgroundColor: connectionColor }]} />
          <Text numberOfLines={1} style={styles.connectionText}>
            {connectionLabel(apiConnection)}
          </Text>
        </View>
        <Pressable
          accessibilityLabel="About and privacy"
          accessibilityRole="button"
          hitSlop={8}
          onPress={() => {
            setIsAboutVisible(true);
          }}
          style={({ pressed }) => [styles.aboutButton, pressed && styles.aboutButtonPressed]}
        >
          <SymbolView
            name={{ android: 'info', ios: 'info.circle' }}
            size={20}
            tintColor={NavOssColors.asphalt}
          />
        </Pressable>
      </View>

      <Animated.View style={[styles.searchBar, animatedSearchBarStyle]}>
        <SymbolView
          name={{ android: 'search', ios: 'magnifyingglass' }}
          size={22}
          tintColor={NavOssColors.asphalt}
        />
        <TextInput
          accessibilityLabel={searchEnabled ? 'Search places' : 'Place search unavailable here'}
          accessibilityState={{ disabled: !searchEnabled }}
          autoCapitalize="words"
          autoCorrect={false}
          enterKeyHint="search"
          onChangeText={(nextQuery) => {
            setResultsExpanded(true);
            onChangeQuery(nextQuery);
          }}
          onBlur={() => {
            searchFocus.value = withTiming(0, {
              duration: 150,
              reduceMotion: ReduceMotion.System,
            });
          }}
          onFocus={() => {
            setResultsExpanded(true);
            searchFocus.value = withTiming(1, {
              duration: 170,
              reduceMotion: ReduceMotion.System,
            });
          }}
          onSubmitEditing={() => {
            setResultsExpanded(false);
            Keyboard.dismiss();
            onSubmit();
          }}
          editable={searchEnabled}
          placeholder={searchEnabled ? searchPlaceholder : 'Place search unavailable here'}
          placeholderTextColor={NavOssColors.muted}
          returnKeyType="search"
          style={styles.input}
          value={query}
        />
        {query.length > 0 && (
          <Animated.View
            entering={FadeIn.duration(140).reduceMotion(ReduceMotion.System)}
            exiting={FadeOut.duration(100).reduceMotion(ReduceMotion.System)}
          >
            <Pressable
              accessibilityLabel="Clear search"
              accessibilityRole="button"
              hitSlop={10}
              onPress={onClear}
              style={({ pressed }) => [styles.clearButton, pressed && styles.aboutButtonPressed]}
            >
              <SymbolView
                name={{ android: 'close', ios: 'xmark' }}
                size={17}
                tintColor={NavOssColors.muted}
              />
            </Pressable>
          </Animated.View>
        )}
      </Animated.View>

      {discoveryActions}

      {showResults && (
        <Animated.View
          entering={FadeInDown.duration(220).reduceMotion(ReduceMotion.System)}
          exiting={FadeOutUp.duration(160).reduceMotion(ReduceMotion.System)}
          layout={LinearTransition.duration(180).reduceMotion(ReduceMotion.System)}
          style={[styles.resultsPanel, { maxHeight: maximumResultsHeight }]}
        >
          {results.length > 0 && (
            <View style={styles.resultsHeader}>
              <Text accessibilityRole="header" style={styles.resultsCount}>
                {results.length} {results.length === 1 ? 'place' : 'places'} found
              </Text>
              <Pressable
                accessibilityHint={
                  resultsExpanded
                    ? 'Collapse the list to explore matching locations on the map'
                    : 'Browse matching places and their distances'
                }
                accessibilityLabel={resultsExpanded ? 'Show map' : 'Show list'}
                accessibilityRole="button"
                accessibilityState={{ expanded: resultsExpanded }}
                onPress={() => {
                  setResultsExpanded((expanded) => !expanded);
                  if (resultsExpanded) Keyboard.dismiss();
                }}
                style={({ pressed }) => [
                  styles.presentationButton,
                  pressed && styles.resultRowPressed,
                ]}
              >
                <SymbolView
                  name={
                    resultsExpanded
                      ? { android: 'map', ios: 'map' }
                      : { android: 'list', ios: 'list.bullet' }
                  }
                  size={16}
                  tintColor={NavOssColors.green}
                />
                <Text style={styles.presentationText}>
                  {resultsExpanded ? 'Show map' : 'Show list'}
                </Text>
              </Pressable>
            </View>
          )}
          {searchState === 'loading' && (
            <Animated.View
              accessibilityLiveRegion="polite"
              entering={FadeIn.duration(150).reduceMotion(ReduceMotion.System)}
              exiting={FadeOut.duration(100).reduceMotion(ReduceMotion.System)}
              style={styles.stateRow}
            >
              <ActivityIndicator color={NavOssColors.green} size="small" />
              <Text style={styles.stateText}>
                {activeCategoryLabel === undefined ? 'Searching places' : 'Finding nearby places'}
              </Text>
            </Animated.View>
          )}

          {searchState === 'error' && (
            <Animated.View
              accessibilityLiveRegion="polite"
              accessibilityRole="alert"
              entering={FadeIn.duration(150).reduceMotion(ReduceMotion.System)}
              exiting={FadeOut.duration(100).reduceMotion(ReduceMotion.System)}
              style={styles.stateRow}
            >
              <SymbolView
                name={{ android: 'wifi_off', ios: 'network.slash' }}
                size={20}
                tintColor={NavOssColors.coral}
              />
              <View style={styles.stateCopy}>
                <Text style={styles.stateTitle}>Search is unavailable right now</Text>
                <Text style={styles.stateText}>Please try your search again in a moment.</Text>
              </View>
            </Animated.View>
          )}

          {searchState === 'success' && results.length === 0 && (
            <Animated.View
              accessibilityLiveRegion="polite"
              entering={FadeIn.duration(150).reduceMotion(ReduceMotion.System)}
              exiting={FadeOut.duration(100).reduceMotion(ReduceMotion.System)}
              style={styles.stateRow}
            >
              <View style={styles.stateCopy}>
                <Text style={styles.stateTitle}>
                  {activeCategoryLabel === undefined
                    ? 'No matches found'
                    : 'No places found nearby'}
                </Text>
                <Text style={styles.stateText}>
                  {activeCategoryLabel === undefined
                    ? 'Try another place name or add a street.'
                    : 'Try another category or search by name.'}
                </Text>
              </View>
            </Animated.View>
          )}

          {results.length > 0 && resultsExpanded && (
            <SectionList
              sections={resultSections}
              keyboardShouldPersistTaps="handled"
              keyExtractor={(result) => result.id}
              renderItem={({ item, section }) => {
                const distance = formatSearchDistance(item.distanceMeters);
                const context = searchResultContext(item);
                const badge = categoryLabel(item, activeCategoryLabel);
                return (
                  <Animated.View
                    entering={FadeIn.duration(160).reduceMotion(ReduceMotion.System)}
                    layout={LinearTransition.duration(160).reduceMotion(ReduceMotion.System)}
                  >
                    <Pressable
                      accessibilityLabel={`Select ${item.name}${badge === '' ? '' : `, ${badge}`}${distance === undefined ? '' : `, ${distance} away`}, ${context}`}
                      accessibilityHint={
                        section.recent
                          ? 'Recently used destination matching this search'
                          : undefined
                      }
                      accessibilityRole="button"
                      onPress={() => {
                        onSelectResult(item);
                      }}
                      style={({ pressed }) => [
                        styles.resultRow,
                        pressed && styles.resultRowPressed,
                      ]}
                    >
                      <View style={styles.resultLead}>
                        <SymbolView
                          name={
                            section.recent
                              ? { android: 'history', ios: 'clock.arrow.circlepath' }
                              : { android: 'location_on', ios: 'mappin' }
                          }
                          size={20}
                          tintColor={section.recent ? NavOssColors.green : NavOssColors.coral}
                        />
                        {distance !== undefined && (
                          <Text style={styles.resultDistance}>{distance}</Text>
                        )}
                      </View>
                      <View style={styles.resultCopy}>
                        <Text numberOfLines={1} style={styles.resultName}>
                          {item.name}
                        </Text>
                        <Text numberOfLines={2} style={styles.resultLabel}>
                          {context}
                        </Text>
                      </View>
                      {badge !== '' && <Text style={styles.category}>{badge}</Text>}
                    </Pressable>
                  </Animated.View>
                );
              }}
              renderSectionHeader={({ section }) =>
                section.title === undefined ? null : (
                  <Text accessibilityRole="header" style={styles.resultSectionTitle}>
                    {section.title}
                  </Text>
                )
              }
              showsVerticalScrollIndicator={false}
              stickySectionHeadersEnabled={false}
              style={styles.resultsList}
            />
          )}

          <View style={styles.fixtureFooter}>
            <Text style={styles.fixtureText}>{searchSourceLabel(searchSource)}</Text>
          </View>
        </Animated.View>
      )}

      <Modal
        animationType="slide"
        onRequestClose={() => {
          setIsAboutVisible(false);
        }}
        presentationStyle="pageSheet"
        visible={isAboutVisible}
      >
        <SafeAreaView style={styles.aboutScreen}>
          <View style={styles.aboutHeader}>
            <Text style={styles.aboutHeaderTitle}>NavOSS</Text>
            <Pressable
              accessibilityLabel="Close about and privacy"
              accessibilityRole="button"
              hitSlop={8}
              onPress={() => {
                setIsAboutVisible(false);
              }}
              style={({ pressed }) => [
                styles.aboutCloseButton,
                pressed && styles.aboutButtonPressed,
              ]}
            >
              <SymbolView
                name={{ android: 'close', ios: 'xmark' }}
                size={20}
                tintColor={NavOssColors.asphalt}
              />
            </Pressable>
          </View>
          <ScrollView contentContainerStyle={styles.aboutContent}>
            <Text style={styles.aboutEyebrow}>CURRENT COVERAGE</Text>
            <Text style={styles.aboutTitle}>Navigation without an account</Text>
            <Text style={styles.aboutLead}>
              NavOSS is account-free, privacy-first navigation with regional official road context.
            </Text>

            <View style={styles.aboutSection}>
              <Text style={styles.aboutSectionTitle}>Search and routing</Text>
              <Text style={styles.aboutBody}>
                Current place search and driving-route coverage: {coverageName}. Regional road
                events, traffic cameras, and public safety facilities may be available elsewhere
                without implying route coverage.
              </Text>
            </View>

            <View style={styles.aboutSection}>
              <Text style={styles.aboutSectionTitle}>Privacy</Text>
              <Text style={styles.aboutBody}>
                Precise location is used to show your position, match you to an active route, detect
                reroutes and arrival, and warn about safety cameras. During active navigation,
                location continues while your phone is locked or connected to CarPlay and iOS shows
                its background location indicator. Search text and route endpoints are sent to the
                NavOSS API and its configured search and routing provider. Current production uses
                self-hosted OpenStreetMap services; a licensed live-traffic deployment may send
                route endpoints to Mapbox. Rerouting sends your latest route origin.
              </Text>
              <Text style={styles.aboutBody}>
                NavOSS does not require an account, show ads, request Always location access, or
                send destination history to its servers. Up to 12 recent destinations and 20 places
                you save are stored only on this device for phone and CarPlay shortcuts. Ending
                navigation stops background location and erases the transient active route.
              </Text>
              {googlePlacesLicenseInfo !== undefined && (
                <Text style={styles.aboutBody}>
                  When a point-of-interest sheet opens, its coordinate is sent directly to Google
                  Places so Google's own component can render available photos, rating and rating
                  count, reviews, and attribution. NavOSS does not retain that Google content.
                  GooglePlacesSwift 10.15.0's embedded privacy manifest also declares Google
                  collection of precise and coarse location, device ID, other data, performance
                  data, product interaction, and search history for analytics and/or app
                  functionality, but not tracking. More reviews open in Google Maps only after you
                  choose the external link.
                </Text>
              )}
              <Pressable
                accessibilityLabel="Clear saved and recent destinations"
                accessibilityRole="button"
                onPress={onClearDestinationHistory}
                style={({ pressed }) => [styles.aboutLink, pressed && styles.aboutButtonPressed]}
              >
                <SymbolView
                  name={{ android: 'delete', ios: 'trash' }}
                  size={15}
                  tintColor={NavOssColors.coral}
                />
                <Text style={styles.aboutDestructiveText}>Clear saved and recent destinations</Text>
              </Pressable>
              <Pressable
                accessibilityLabel="Open NavOSS privacy policy"
                accessibilityRole="link"
                onPress={() => {
                  void Linking.openURL(PRIVACY_POLICY_URL);
                }}
                style={({ pressed }) => [styles.aboutLink, pressed && styles.aboutButtonPressed]}
              >
                <Text style={styles.aboutLinkText}>Privacy policy</Text>
                <SymbolView
                  name={{ android: 'open_in_new', ios: 'arrow.up.right' }}
                  size={15}
                  tintColor={NavOssColors.green}
                />
              </Pressable>
            </View>

            <View style={styles.aboutSection}>
              <Text style={styles.aboutSectionTitle}>Support and feedback</Text>
              <Text style={styles.aboutBody}>
                Route reports are most useful when they include the start area, destination, time,
                and unexpected road or maneuver. Avoid including a private address unless it is
                necessary to reproduce the issue.
              </Text>
              <Pressable
                accessibilityLabel="Open NavOSS support"
                accessibilityRole="link"
                onPress={() => {
                  void Linking.openURL(SUPPORT_URL);
                }}
                style={({ pressed }) => [styles.aboutLink, pressed && styles.aboutButtonPressed]}
              >
                <Text style={styles.aboutLinkText}>Support</Text>
                <SymbolView
                  name={{ android: 'open_in_new', ios: 'arrow.up.right' }}
                  size={15}
                  tintColor={NavOssColors.green}
                />
              </Pressable>
            </View>

            <View style={styles.aboutSection}>
              <Text style={styles.aboutSectionTitle}>Data and safety</Text>
              <Text style={styles.aboutBody}>
                Map and search data comes from OpenStreetMap contributors. Regional context can
                include official municipal or provincial road events, enforcement cameras, ordinary
                traffic webcams, and fixed public safety facilities; each is labelled by source and
                type. Routes come from self-hosted Valhalla unless a licensed Mapbox traffic
                provider is explicitly enabled and attributed. Data and alerts may be incomplete or
                outdated; always follow posted signs and road laws.
              </Text>
              {googlePlacesLicenseInfo !== undefined && (
                <Pressable
                  accessibilityLabel="Open Google Places open-source licences"
                  accessibilityRole="button"
                  onPress={() => {
                    setIsGoogleLicensesVisible(true);
                  }}
                  style={({ pressed }) => [styles.aboutLink, pressed && styles.aboutButtonPressed]}
                >
                  <Text style={styles.aboutLinkText}>Google Places licences</Text>
                  <SymbolView
                    name={{ android: 'chevron_right', ios: 'chevron.right' }}
                    size={15}
                    tintColor={NavOssColors.green}
                  />
                </Pressable>
              )}
            </View>
          </ScrollView>
        </SafeAreaView>
      </Modal>

      <Modal
        animationType="slide"
        onRequestClose={() => {
          setIsGoogleLicensesVisible(false);
        }}
        presentationStyle="pageSheet"
        visible={isGoogleLicensesVisible}
      >
        <SafeAreaView style={styles.aboutScreen}>
          <View style={styles.aboutHeader}>
            <Text style={styles.aboutHeaderTitle}>Google Places licences</Text>
            <Pressable
              accessibilityLabel="Close Google Places licences"
              accessibilityRole="button"
              hitSlop={8}
              onPress={() => {
                setIsGoogleLicensesVisible(false);
              }}
              style={({ pressed }) => [
                styles.aboutCloseButton,
                pressed && styles.aboutButtonPressed,
              ]}
            >
              <SymbolView
                name={{ android: 'close', ios: 'xmark' }}
                size={20}
                tintColor={NavOssColors.asphalt}
              />
            </Pressable>
          </View>
          <ScrollView contentContainerStyle={styles.licenseContent}>
            <Text selectable style={styles.licenseText}>
              {googlePlacesLicenseInfo ?? 'No Google Places licences in this build.'}
            </Text>
          </ScrollView>
        </SafeAreaView>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  aboutBody: {
    color: NavOssColors.asphalt,
    fontFamily: NavOssFonts.regular,
    fontSize: 16,
    letterSpacing: 0,
    lineHeight: 24,
  },
  aboutButton: {
    alignItems: 'center',
    backgroundColor: NavOssColors.paper,
    borderColor: NavOssColors.border,
    borderRadius: Spacing.four,
    borderWidth: StyleSheet.hairlineWidth,
    height: 44,
    justifyContent: 'center',
    width: 44,
  },
  aboutButtonPressed: {
    backgroundColor: NavOssColors.fog,
  },
  aboutCloseButton: {
    alignItems: 'center',
    borderRadius: Spacing.four,
    height: 44,
    justifyContent: 'center',
    width: 44,
  },
  aboutContent: {
    gap: Spacing.five,
    paddingBottom: Spacing.five,
    paddingHorizontal: Spacing.four,
    paddingTop: Spacing.five,
  },
  aboutDestructiveText: {
    color: NavOssColors.asphalt,
    fontFamily: NavOssFonts.semibold,
    fontSize: 16,
    letterSpacing: 0,
  },
  aboutEyebrow: {
    color: NavOssColors.green,
    fontFamily: NavOssFonts.bold,
    fontSize: 12,
    letterSpacing: 0,
  },
  aboutHeader: {
    alignItems: 'center',
    borderBottomColor: NavOssColors.border,
    borderBottomWidth: StyleSheet.hairlineWidth,
    flexDirection: 'row',
    height: 56,
    justifyContent: 'space-between',
    paddingHorizontal: 16,
  },
  aboutHeaderTitle: {
    color: NavOssColors.asphalt,
    fontFamily: NavOssFonts.bold,
    fontSize: 18,
    letterSpacing: 0,
  },
  aboutLead: {
    color: NavOssColors.muted,
    fontFamily: NavOssFonts.regular,
    fontSize: 18,
    letterSpacing: 0,
    lineHeight: 28,
  },
  aboutLink: {
    alignItems: 'center',
    alignSelf: 'flex-start',
    flexDirection: 'row',
    gap: Spacing.two,
    minHeight: 44,
  },
  aboutLinkText: {
    color: NavOssColors.green,
    fontFamily: NavOssFonts.semibold,
    fontSize: 16,
    letterSpacing: 0,
  },
  aboutScreen: {
    backgroundColor: NavOssColors.paper,
    flex: 1,
  },
  aboutSection: {
    borderTopColor: NavOssColors.border,
    borderTopWidth: StyleSheet.hairlineWidth,
    gap: Spacing.three,
    paddingTop: Spacing.four,
  },
  aboutSectionTitle: {
    color: NavOssColors.asphalt,
    fontFamily: NavOssFonts.bold,
    fontSize: 20,
    letterSpacing: 0,
  },
  aboutTitle: {
    color: NavOssColors.asphalt,
    fontFamily: NavOssFonts.bold,
    fontSize: 32,
    letterSpacing: 0,
    lineHeight: 38,
  },
  brandMark: {
    borderRadius: Spacing.two,
    height: Spacing.five,
    width: Spacing.five,
  },
  brandName: {
    color: NavOssColors.asphalt,
    fontFamily: NavOssFonts.bold,
    fontSize: 22,
    letterSpacing: 0,
  },
  brandNameDark: {
    color: NavOssColors.paper,
    textShadowColor: NavOssColors.asphalt,
    textShadowOffset: { height: 1, width: 0 },
    textShadowRadius: Spacing.one,
  },
  brandRow: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: Spacing.two,
    minHeight: 44,
  },
  category: {
    color: NavOssColors.muted,
    fontFamily: NavOssFonts.medium,
    fontSize: 12,
    letterSpacing: 0,
    maxWidth: Spacing.six + Spacing.five,
    textAlign: 'right',
    textTransform: 'capitalize',
  },
  clearButton: {
    alignItems: 'center',
    borderRadius: Spacing.four,
    height: 44,
    justifyContent: 'center',
    width: 44,
  },
  connectionDot: {
    borderRadius: 4,
    height: 8,
    width: 8,
  },
  connectionStatus: {
    alignItems: 'center',
    backgroundColor: NavOssColors.paper,
    borderColor: NavOssColors.border,
    borderRadius: Spacing.three,
    borderWidth: StyleSheet.hairlineWidth,
    flexDirection: 'row',
    flexShrink: 1,
    gap: Spacing.one,
    marginLeft: 'auto',
    maxWidth: '52%',
    paddingHorizontal: Spacing.two,
    paddingVertical: Spacing.one,
  },
  connectionText: {
    color: NavOssColors.muted,
    flexShrink: 1,
    fontFamily: NavOssFonts.medium,
    fontSize: 12,
    letterSpacing: 0,
  },
  container: {
    gap: Spacing.two,
    marginHorizontal: Spacing.three,
    zIndex: 20,
  },
  fixtureFooter: {
    alignItems: 'center',
    backgroundColor: NavOssColors.fog,
    borderTopColor: NavOssColors.border,
    borderTopWidth: StyleSheet.hairlineWidth,
    flexShrink: 0,
    minHeight: Spacing.five,
    justifyContent: 'center',
    paddingHorizontal: Spacing.three,
    paddingVertical: Spacing.one,
  },
  fixtureText: {
    color: NavOssColors.muted,
    fontFamily: NavOssFonts.medium,
    fontSize: 12,
    letterSpacing: 0,
  },
  input: {
    color: NavOssColors.asphalt,
    flex: 1,
    fontFamily: NavOssFonts.regular,
    fontSize: 18,
    height: 52,
    letterSpacing: 0,
    paddingVertical: 0,
  },
  licenseContent: {
    paddingBottom: 44,
    paddingHorizontal: 20,
    paddingTop: 22,
  },
  licenseText: {
    color: NavOssColors.asphalt,
    fontFamily: NavOssFonts.regular,
    fontSize: 13,
    letterSpacing: 0,
    lineHeight: 19,
  },
  resultCopy: {
    flex: 1,
    gap: Spacing.one,
    minWidth: 0,
  },
  resultDistance: {
    color: NavOssColors.asphalt,
    fontFamily: NavOssFonts.semibold,
    fontSize: 14,
    letterSpacing: 0,
    lineHeight: 20,
  },
  resultLead: {
    alignItems: 'center',
    flexShrink: 0,
    gap: Spacing.one,
    minHeight: 44,
    justifyContent: 'center',
    minWidth: Spacing.five + Spacing.four,
  },
  resultLabel: {
    color: NavOssColors.muted,
    fontFamily: NavOssFonts.regular,
    fontSize: 14,
    letterSpacing: 0,
    lineHeight: 20,
  },
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
    minHeight: Spacing.six + Spacing.two,
    paddingHorizontal: Spacing.three,
    paddingVertical: Spacing.two,
  },
  resultRowPressed: {
    backgroundColor: NavOssColors.sky,
  },
  resultSectionTitle: {
    backgroundColor: NavOssColors.fog,
    color: NavOssColors.asphalt,
    fontFamily: NavOssFonts.semibold,
    fontSize: 14,
    paddingHorizontal: Spacing.three,
    paddingVertical: Spacing.two,
  },
  resultsCount: {
    color: NavOssColors.asphalt,
    flex: 1,
    fontFamily: NavOssFonts.semibold,
    fontSize: 14,
    minWidth: 0,
  },
  resultsHeader: {
    alignItems: 'center',
    borderBottomColor: NavOssColors.border,
    borderBottomWidth: StyleSheet.hairlineWidth,
    flexDirection: 'row',
    flexShrink: 0,
    gap: Spacing.two,
    paddingHorizontal: Spacing.three,
    paddingVertical: Spacing.one,
  },
  resultsList: {
    flexShrink: 1,
  },
  presentationButton: {
    alignItems: 'center',
    borderRadius: Spacing.two,
    flexDirection: 'row',
    gap: Spacing.two,
    minHeight: 44,
    paddingHorizontal: Spacing.two,
  },
  presentationText: {
    color: NavOssColors.asphalt,
    fontFamily: NavOssFonts.semibold,
    fontSize: 14,
  },
  resultsPanel: {
    backgroundColor: NavOssColors.paper,
    borderColor: NavOssColors.border,
    borderRadius: Spacing.three,
    borderWidth: StyleSheet.hairlineWidth,
    flexShrink: 1,
    overflow: 'hidden',
    shadowColor: NavOssColors.asphalt,
    shadowOffset: { height: Spacing.one, width: 0 },
    shadowOpacity: 0.14,
    shadowRadius: 16,
  },
  searchBar: {
    alignItems: 'center',
    backgroundColor: NavOssColors.paper,
    borderColor: NavOssColors.border,
    borderRadius: Spacing.five,
    borderWidth: 2,
    flexDirection: 'row',
    gap: Spacing.two,
    height: 56,
    paddingLeft: Spacing.three,
    paddingRight: Spacing.one,
    shadowColor: NavOssColors.asphalt,
    shadowOffset: { height: Spacing.one, width: 0 },
    shadowOpacity: 0.1,
    shadowRadius: 12,
  },
  stateCopy: {
    flex: 1,
    gap: Spacing.one,
  },
  stateRow: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: Spacing.two,
    minHeight: Spacing.six,
    paddingHorizontal: Spacing.three,
    paddingVertical: Spacing.three,
  },
  stateText: {
    color: NavOssColors.muted,
    flexShrink: 1,
    fontFamily: NavOssFonts.regular,
    fontSize: 14,
    letterSpacing: 0,
    lineHeight: 20,
  },
  stateTitle: {
    color: NavOssColors.asphalt,
    fontFamily: NavOssFonts.semibold,
    fontSize: 16,
    lineHeight: 20,
  },
});
