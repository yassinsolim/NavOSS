import type { SearchResult } from '@navoss/contracts';
import { Alert, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import Animated, { FadeIn, FadeOut, ReduceMotion } from 'react-native-reanimated';

import { TAB_BAR_HEIGHT } from '@/features/map/overlay-layout';
import {
  type NativeDestinationCatalog,
  nativeDestinationToSearchResult,
} from '@/features/navigation/native-navigation';
import { createThemedStyles, motion, radius, space, typography, useTheme } from '@/theme';
import { IconButton } from '@/ui/icon-button';
import { ListRow } from '@/ui/list-row';
import { SectionTitle } from '@/ui/sheet/sheet-header';
import { StateView } from '@/ui/state-view';

interface SavedPlacesScreenProps {
  bottomInset: number;
  catalog: NativeDestinationCatalog;
  onChoose: (place: SearchResult) => void;
  onClearHistory: () => void;
  onRemoveShortcut: (shortcut: 'home' | 'work') => void;
  onSetShortcut: (shortcut: 'home' | 'work') => void;
  safeAreaTop: number;
}

function ShortcutRow({
  onChange,
  onChoose,
  onRemove,
  place,
  shortcut,
}: {
  onChange: () => void;
  onChoose: (place: SearchResult) => void;
  onRemove: () => void;
  place: SearchResult | undefined;
  shortcut: 'home' | 'work';
}) {
  const { colors } = useTheme();
  const label = shortcut === 'home' ? 'Home' : 'Work';
  const icon =
    shortcut === 'home'
      ? ({ android: 'home', ios: place === undefined ? 'house' : 'house.fill' } as const)
      : ({ android: 'work', ios: place === undefined ? 'briefcase' : 'briefcase.fill' } as const);

  if (place === undefined) {
    return (
      <ListRow
        accessibilityLabel={`Set ${label}`}
        icon={icon}
        onPress={onChange}
        subtitle="Add a private shortcut on this device"
        title={`Set ${label}`}
        trailing="chevron"
      />
    );
  }

  // The row and its two actions are siblings, so each is its own accessible element.
  return (
    <View style={shortcutStyles.row}>
      <ListRow
        accessibilityLabel={`${label}, ${place.name}, ${place.label}`}
        eyebrow={label}
        icon={icon}
        onPress={() => {
          onChoose(place);
        }}
        style={shortcutStyles.main}
        subtitle={place.label}
        subtitleLines={1}
        title={place.name}
      />
      <IconButton
        accessibilityLabel={`Change ${label}`}
        icon={{ android: 'edit', ios: 'pencil' }}
        iconSize={17}
        onPress={onChange}
        variant="plain"
      />
      <IconButton
        accessibilityLabel={`Remove ${label}`}
        icon={{ android: 'delete', ios: 'trash' }}
        iconSize={17}
        onPress={() => {
          Alert.alert(`Remove ${label}?`, 'This removes the private shortcut from this device.', [
            { style: 'cancel', text: 'Cancel' },
            { onPress: onRemove, style: 'destructive', text: 'Remove' },
          ]);
        }}
        tintColor={colors.dangerText}
        variant="plain"
      />
    </View>
  );
}

const shortcutStyles = StyleSheet.create({
  main: { flex: 1 },
  row: { alignItems: 'center', flexDirection: 'row' },
});

/** Home, Work, favourites and recent destinations. All of it lives only on this device. */
export function SavedPlacesScreen({
  bottomInset,
  catalog,
  onChoose,
  onClearHistory,
  onRemoveShortcut,
  onSetShortcut,
  safeAreaTop,
}: SavedPlacesScreenProps) {
  const styles = useStyles();
  const favorites = catalog.favorites.map(nativeDestinationToSearchResult);
  const recents = catalog.recents.map(nativeDestinationToSearchResult);

  return (
    <Animated.View
      entering={FadeIn.duration(motion.duration.base).reduceMotion(ReduceMotion.System)}
      exiting={FadeOut.duration(motion.duration.fast).reduceMotion(ReduceMotion.System)}
      style={[styles.screen, { paddingTop: safeAreaTop }]}
    >
      <ScrollView
        contentContainerStyle={[
          styles.content,
          { paddingBottom: TAB_BAR_HEIGHT + bottomInset + space.xxl },
        ]}
        showsVerticalScrollIndicator={false}
      >
        <View style={styles.header}>
          <Text style={styles.eyebrow}>Your places</Text>
          <Text accessibilityRole="header" style={styles.title}>
            Saved places
          </Text>
          <Text style={styles.subtitle}>Private shortcuts stored only on this device.</Text>
        </View>

        <View style={styles.section}>
          <SectionTitle>Shortcuts</SectionTitle>
          <View style={styles.card}>
            {(['home', 'work'] as const).map((shortcut) => {
              const destination = catalog[shortcut];
              return (
                <ShortcutRow
                  key={shortcut}
                  onChange={() => {
                    onSetShortcut(shortcut);
                  }}
                  onChoose={onChoose}
                  onRemove={() => {
                    onRemoveShortcut(shortcut);
                  }}
                  place={
                    destination === undefined
                      ? undefined
                      : nativeDestinationToSearchResult(destination)
                  }
                  shortcut={shortcut}
                />
              );
            })}
          </View>
        </View>

        <View style={styles.section}>
          <SectionTitle>Favourites</SectionTitle>
          <View style={styles.card}>
            {favorites.length === 0 ? (
              <StateView
                message="Open a place and choose Save to keep it here."
                title="No favourites yet"
                visual={{ android: 'bookmark_border', ios: 'bookmark' }}
              />
            ) : (
              favorites.map((place) => (
                <ListRow
                  accessibilityLabel={`${place.name}, ${place.label}`}
                  icon={{ android: 'bookmark', ios: 'bookmark.fill' }}
                  key={place.id}
                  onPress={() => {
                    onChoose(place);
                  }}
                  subtitle={place.label}
                  subtitleLines={1}
                  title={place.name}
                  trailing="chevron"
                />
              ))
            )}
          </View>
        </View>

        <View style={styles.section}>
          <SectionTitle
            trailing={
              recents.length > 0 ? (
                <Pressable
                  accessibilityLabel="Clear recent places"
                  accessibilityRole="button"
                  hitSlop={12}
                  onPress={onClearHistory}
                >
                  <Text style={styles.clearText}>Clear</Text>
                </Pressable>
              ) : undefined
            }
          >
            Recent
          </SectionTitle>
          <View style={styles.card}>
            {recents.length === 0 ? (
              <StateView
                message="Destinations you get directions to appear here."
                title="No recent destinations yet"
                visual={{ android: 'history', ios: 'clock.arrow.circlepath' }}
              />
            ) : (
              recents.map((place) => (
                <ListRow
                  accessibilityLabel={`${place.name}, ${place.label}`}
                  icon={{ android: 'history', ios: 'clock.arrow.circlepath' }}
                  key={place.id}
                  onPress={() => {
                    onChoose(place);
                  }}
                  subtitle={place.label}
                  subtitleLines={1}
                  title={place.name}
                  trailing="chevron"
                />
              ))
            )}
          </View>
        </View>
      </ScrollView>
    </Animated.View>
  );
}

const useStyles = createThemedStyles(({ colors }) =>
  StyleSheet.create({
    card: {
      backgroundColor: colors.surface,
      borderColor: colors.border,
      borderCurve: 'continuous',
      borderRadius: radius.lg,
      borderWidth: StyleSheet.hairlineWidth,
      padding: space.xs,
    },
    clearText: { ...typography.label, color: colors.primaryText },
    content: { gap: space.xxl, paddingHorizontal: space.lg, paddingTop: space.lg },
    eyebrow: { ...typography.eyebrow, color: colors.primaryText },
    header: { gap: space.xs },
    screen: {
      backgroundColor: colors.background,
      bottom: 0,
      left: 0,
      position: 'absolute',
      right: 0,
      top: 0,
    },
    section: { gap: space.sm },
    subtitle: { ...typography.body, color: colors.textSecondary },
    title: { ...typography.largeTitle, color: colors.text },
  }),
);
