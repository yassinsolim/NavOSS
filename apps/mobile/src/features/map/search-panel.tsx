import type { SearchResult, SearchSource } from '@navoss/contracts';
import { SymbolView } from 'expo-symbols';
import {
  ActivityIndicator,
  FlatList,
  Image,
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
import { useState } from 'react';

import { NavOssColors, NavOssFonts } from '@/constants/navoss-theme';

const PRIVACY_POLICY_URL = 'https://navoss.yassin.app/privacy';
const SUPPORT_URL = 'https://navoss.yassin.app/support';

export type ApiConnectionState = 'connecting' | 'online' | 'offline';
export type SearchState = 'idle' | 'loading' | 'success' | 'error';

interface SearchPanelProps {
  apiConnection: ApiConnectionState;
  coverageName: string;
  maximumResultsHeight: number;
  onChangeQuery: (query: string) => void;
  onClear: () => void;
  onSelectResult: (result: SearchResult) => void;
  onSubmit: () => void;
  query: string;
  results: SearchResult[];
  searchSource: SearchSource | undefined;
  searchState: SearchState;
}

function connectionLabel(state: ApiConnectionState, coverageName: string): string {
  if (state === 'offline') {
    return 'Local API offline';
  }

  if (state === 'connecting') {
    return 'Connecting';
  }

  return coverageName;
}

function categoryLabel(category: SearchResult['category']): string {
  return category === 'poi' ? 'Point of interest' : category;
}

function searchSourceLabel(source: SearchSource | undefined): string {
  if (source === undefined) {
    return 'Calgary place search';
  }

  return source.freshness === 'static'
    ? 'Static Calgary fallback'
    : source.id === 'nominatim-self-hosted'
      ? 'OpenStreetMap search'
      : 'OpenStreetMap search · Development';
}

export function SearchPanel({
  apiConnection,
  coverageName,
  maximumResultsHeight,
  onChangeQuery,
  onClear,
  onSelectResult,
  onSubmit,
  query,
  results,
  searchSource,
  searchState,
}: SearchPanelProps) {
  const [isAboutVisible, setIsAboutVisible] = useState(false);
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
        <Text style={styles.brandName}>NavOSS</Text>
        <View style={styles.connectionStatus}>
          <View style={[styles.connectionDot, { backgroundColor: connectionColor }]} />
          <Text numberOfLines={1} style={styles.connectionText}>
            {connectionLabel(apiConnection, coverageName)}
          </Text>
        </View>
        <Pressable
          accessibilityLabel="About and privacy"
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

      <View style={styles.searchBar}>
        <SymbolView
          name={{ android: 'search', ios: 'magnifyingglass' }}
          size={22}
          tintColor={NavOssColors.asphalt}
        />
        <TextInput
          accessibilityLabel="Search Calgary"
          autoCapitalize="words"
          autoCorrect={false}
          enterKeyHint="search"
          onChangeText={onChangeQuery}
          onSubmitEditing={onSubmit}
          placeholder="Where to?"
          placeholderTextColor={NavOssColors.muted}
          returnKeyType="search"
          style={styles.input}
          value={query}
        />
        {query.length > 0 && (
          <Pressable
            accessibilityLabel="Clear search"
            hitSlop={10}
            onPress={onClear}
            style={styles.clearButton}
          >
            <SymbolView
              name={{ android: 'close', ios: 'xmark' }}
              size={17}
              tintColor={NavOssColors.muted}
            />
          </Pressable>
        )}
      </View>

      {showResults && (
        <View style={[styles.resultsPanel, { maxHeight: maximumResultsHeight }]}>
          {searchState === 'loading' && (
            <View style={styles.stateRow}>
              <ActivityIndicator color={NavOssColors.green} size="small" />
              <Text style={styles.stateText}>Searching Calgary</Text>
            </View>
          )}

          {searchState === 'error' && (
            <View style={styles.stateRow}>
              <SymbolView
                name={{ android: 'wifi_off', ios: 'network.slash' }}
                size={20}
                tintColor={NavOssColors.coral}
              />
              <Text style={styles.stateText}>Search service unavailable</Text>
            </View>
          )}

          {searchState === 'success' && results.length === 0 && (
            <View style={styles.stateRow}>
              <Text style={styles.stateText}>No places found</Text>
            </View>
          )}

          {results.length > 0 && (
            <FlatList
              data={results}
              keyboardShouldPersistTaps="handled"
              keyExtractor={(result) => result.id}
              renderItem={({ item }) => (
                <Pressable
                  accessibilityLabel={`Select ${item.name}`}
                  onPress={() => {
                    onSelectResult(item);
                  }}
                  style={({ pressed }) => [styles.resultRow, pressed && styles.resultRowPressed]}
                >
                  <View style={styles.resultIcon}>
                    <SymbolView
                      name={{ android: 'location_on', ios: 'mappin' }}
                      size={20}
                      tintColor={NavOssColors.coral}
                    />
                  </View>
                  <View style={styles.resultCopy}>
                    <Text numberOfLines={1} style={styles.resultName}>
                      {item.name}
                    </Text>
                    <Text numberOfLines={1} style={styles.resultLabel}>
                      {item.label}
                    </Text>
                  </View>
                  <Text style={styles.category}>{categoryLabel(item.category)}</Text>
                </Pressable>
              )}
              showsVerticalScrollIndicator={false}
            />
          )}

          <View style={styles.fixtureFooter}>
            <Text style={styles.fixtureText}>{searchSourceLabel(searchSource)}</Text>
          </View>
        </View>
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
            <Text style={styles.aboutEyebrow}>CALGARY COVERAGE</Text>
            <Text style={styles.aboutTitle}>Navigation without an account</Text>
            <Text style={styles.aboutLead}>
              NavOSS is account-free, privacy-first navigation for Calgary.
            </Text>

            <View style={styles.aboutSection}>
              <Text style={styles.aboutSectionTitle}>Privacy</Text>
              <Text style={styles.aboutBody}>
                Precise foreground location is used to show your position, match you to an active
                route, detect reroutes and arrival, and warn about safety cameras. Search text and
                route endpoints are sent to the NavOSS API and its configured OpenStreetMap-based
                search and routing services. Rerouting sends your latest route origin.
              </Text>
              <Text style={styles.aboutBody}>
                NavOSS does not require an account, show ads, ask for background location, or save
                trip history in the app.
              </Text>
              <Pressable
                accessibilityLabel="Open NavOSS privacy policy"
                accessibilityRole="link"
                onPress={() => {
                  void Linking.openURL(PRIVACY_POLICY_URL);
                }}
                style={styles.aboutLink}
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
                style={styles.aboutLink}
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
                Map and search data comes from OpenStreetMap contributors. Safety-camera data comes
                from City of Calgary Open Data. Routes come from the configured Valhalla service.
                Data and alerts may be incomplete or outdated; always follow posted signs and road
                laws.
              </Text>
            </View>
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
    lineHeight: 25,
  },
  aboutButton: {
    alignItems: 'center',
    borderColor: NavOssColors.border,
    borderRadius: 17,
    borderWidth: StyleSheet.hairlineWidth,
    height: 34,
    justifyContent: 'center',
    width: 34,
  },
  aboutButtonPressed: {
    backgroundColor: NavOssColors.fog,
  },
  aboutCloseButton: {
    alignItems: 'center',
    borderRadius: 20,
    height: 40,
    justifyContent: 'center',
    width: 40,
  },
  aboutContent: {
    gap: 28,
    paddingBottom: 44,
    paddingHorizontal: 24,
    paddingTop: 34,
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
    lineHeight: 27,
  },
  aboutLink: {
    alignItems: 'center',
    alignSelf: 'flex-start',
    flexDirection: 'row',
    gap: 7,
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
    gap: 12,
    paddingTop: 22,
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
    borderRadius: 6,
    height: 30,
    width: 30,
  },
  brandName: {
    color: NavOssColors.asphalt,
    fontFamily: NavOssFonts.bold,
    fontSize: 22,
    letterSpacing: 0,
  },
  brandRow: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 9,
    height: 34,
  },
  category: {
    color: NavOssColors.green,
    fontFamily: NavOssFonts.medium,
    fontSize: 12,
    letterSpacing: 0,
    maxWidth: 92,
    textAlign: 'right',
    textTransform: 'capitalize',
  },
  clearButton: {
    alignItems: 'center',
    height: 36,
    justifyContent: 'center',
    width: 36,
  },
  connectionDot: {
    borderRadius: 4,
    height: 8,
    width: 8,
  },
  connectionStatus: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 6,
    marginLeft: 'auto',
    maxWidth: '52%',
  },
  connectionText: {
    color: NavOssColors.muted,
    fontFamily: NavOssFonts.medium,
    fontSize: 12,
    letterSpacing: 0,
  },
  container: {
    gap: 10,
    marginHorizontal: 14,
    zIndex: 20,
  },
  fixtureFooter: {
    alignItems: 'center',
    borderTopColor: NavOssColors.border,
    borderTopWidth: StyleSheet.hairlineWidth,
    minHeight: 30,
    justifyContent: 'center',
    paddingHorizontal: 12,
  },
  fixtureText: {
    color: NavOssColors.muted,
    fontFamily: NavOssFonts.medium,
    fontSize: 11,
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
  resultCopy: {
    flex: 1,
    gap: 2,
    minWidth: 0,
  },
  resultIcon: {
    alignItems: 'center',
    backgroundColor: '#FCE9E5',
    borderRadius: 8,
    height: 38,
    justifyContent: 'center',
    width: 38,
  },
  resultLabel: {
    color: NavOssColors.muted,
    fontFamily: NavOssFonts.regular,
    fontSize: 13,
    letterSpacing: 0,
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
    gap: 10,
    minHeight: 62,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  resultRowPressed: {
    backgroundColor: NavOssColors.fog,
  },
  resultsPanel: {
    backgroundColor: NavOssColors.white,
    borderColor: NavOssColors.border,
    borderRadius: 8,
    borderWidth: StyleSheet.hairlineWidth,
    overflow: 'hidden',
    shadowColor: '#000000',
    shadowOffset: { height: 5, width: 0 },
    shadowOpacity: 0.14,
    shadowRadius: 16,
  },
  searchBar: {
    alignItems: 'center',
    backgroundColor: NavOssColors.white,
    borderColor: NavOssColors.border,
    borderRadius: 27,
    borderWidth: StyleSheet.hairlineWidth,
    flexDirection: 'row',
    gap: 10,
    height: 54,
    paddingLeft: 15,
    paddingRight: 8,
    shadowColor: '#000000',
    shadowOffset: { height: 3, width: 0 },
    shadowOpacity: 0.16,
    shadowRadius: 12,
  },
  stateRow: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 10,
    minHeight: 58,
    paddingHorizontal: 16,
  },
  stateText: {
    color: NavOssColors.muted,
    fontFamily: NavOssFonts.medium,
    fontSize: 15,
    letterSpacing: 0,
  },
});
