import type { SearchResult, SearchSource } from '@navoss/contracts';
import { SymbolView } from 'expo-symbols';
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';

import { NavOssColors, NavOssFonts } from '@/constants/navoss-theme';

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
        <View style={styles.brandMark}>
          <Text style={styles.brandLetter}>N</Text>
        </View>
        <Text style={styles.brandName}>NavOSS</Text>
        <View style={styles.connectionStatus}>
          <View style={[styles.connectionDot, { backgroundColor: connectionColor }]} />
          <Text numberOfLines={1} style={styles.connectionText}>
            {connectionLabel(apiConnection, coverageName)}
          </Text>
        </View>
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
    </View>
  );
}

const styles = StyleSheet.create({
  brandLetter: {
    color: NavOssColors.asphalt,
    fontFamily: NavOssFonts.bold,
    fontSize: 18,
    letterSpacing: 0,
    lineHeight: 22,
  },
  brandMark: {
    alignItems: 'center',
    backgroundColor: NavOssColors.sun,
    borderRadius: 6,
    height: 30,
    justifyContent: 'center',
    transform: [{ rotate: '-4deg' }],
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
