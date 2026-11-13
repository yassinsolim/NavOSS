import type { SearchResult } from '@navoss/contracts';
import { SymbolView } from 'expo-symbols';
import { useEffect, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import type { SharedValue } from 'react-native-reanimated';

import { GooglePlaceRating } from '@/features/map/google-place-rating';
import {
  placeOpenStatus,
  placeOpenStatusLabel,
  type PlaceOpenStatus,
} from '@/features/map/map-place';
import { placeSheetDetents, type ScreenMetrics } from '@/features/map/overlay-layout';
import { searchResultContext } from '@/features/map/search-proximity';
import { categoryLabel } from '@/features/map/search-result-category';
import { type ColorRoles, createThemedStyles, radius, space, typography, useTheme } from '@/theme';
import { Button, type SymbolName } from '@/ui/button';
import { ListRow } from '@/ui/list-row';
import { PressableScale } from '@/ui/pressable-scale';
import { BottomSheet, BottomSheetReveal, BottomSheetScrollView } from '@/ui/sheet/bottom-sheet';
import { SheetHeader } from '@/ui/sheet/sheet-header';
import { StateView } from '@/ui/state-view';

interface PlaceSheetProps {
  loading: boolean;
  metrics: ScreenMetrics;
  onCall?: () => void;
  onClose: () => void;
  onDirections: () => void;
  onFindParking?: () => void;
  onReadReviews: () => void;
  onSave: () => void;
  onShare: () => void;
  onWebsite?: () => void;
  place: SearchResult;
  position: SharedValue<number>;
  ratingAvailable: boolean;
  saved: boolean;
  websiteLabel?: string;
}

function wheelchairLabel(value: string): string {
  if (value === 'yes') return 'Wheelchair access available';
  if (value === 'limited') return 'Limited wheelchair access';
  if (value === 'no') return 'No wheelchair access indicated';
  const readable = value
    .split('_')
    .map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
    .join(' ');
  return `Wheelchair access: ${readable}`;
}

function openStatusColor(status: PlaceOpenStatus, colors: ColorRoles): string {
  if (status === 'open') return colors.success;
  if (status === 'closing-soon') return colors.warning;
  return colors.danger;
}

function SecondaryAction({
  accessibilityHint,
  icon,
  label,
  onPress,
  selected = false,
}: {
  accessibilityHint?: string;
  icon: SymbolName;
  label: string;
  onPress: () => void;
  selected?: boolean;
}) {
  const { colors } = useTheme();
  const styles = useStyles();
  return (
    <PressableScale
      accessibilityHint={accessibilityHint}
      accessibilityLabel={label}
      accessibilityRole="button"
      accessibilityState={{ selected }}
      onPress={onPress}
      style={[styles.secondaryAction, selected && styles.secondaryActionSelected]}
    >
      <SymbolView name={icon} size={20} tintColor={colors.primaryText} />
      <Text maxFontSizeMultiplier={1.2} numberOfLines={1} style={styles.secondaryActionLabel}>
        {label}
      </Text>
    </PressableScale>
  );
}

/**
 * Place details. At rest it shows the name and what you can do with the place; dragging up
 * reveals what is known about it. Missing details are stated, never invented.
 */
export function PlaceSheet({
  loading,
  metrics,
  onCall,
  onClose,
  onDirections,
  onFindParking,
  onReadReviews,
  onSave,
  onShare,
  onWebsite,
  place,
  position,
  ratingAvailable,
  saved,
  websiteLabel,
}: PlaceSheetProps) {
  const { colors } = useTheme();
  const styles = useStyles();
  const detents = placeSheetDetents(metrics);
  const details = place.details;
  const category = categoryLabel(place, undefined) || searchResultContext(place);
  const [now, setNow] = useState(() => new Date());
  const openingHours = details?.openingHours;
  const openStatus = openingHours === undefined ? undefined : placeOpenStatus(place, now);

  useEffect(() => {
    setNow(new Date());
    if (openingHours === undefined) return undefined;
    // Only tick while a resolvable status needs to stay current; there is nothing to refresh
    // otherwise, and this timer is torn down whenever the place or its hours change.
    const timer = setInterval(() => {
      setNow(new Date());
    }, 60_000);
    return () => {
      clearInterval(timer);
    };
  }, [place.id, openingHours]);

  return (
    <BottomSheet
      accessibilityLabel={`${place.name} details`}
      detents={detents.values}
      initialDetent={detents.initial}
      position={position}
    >
      <SheetHeader
        closeLabel="Close place details"
        onClose={onClose}
        subtitle={category}
        title={place.name}
      />
      <View style={styles.actions}>
        <Button
          icon={{ android: 'directions', ios: 'arrow.triangle.turn.up.right.diamond.fill' }}
          label="Directions"
          onPress={onDirections}
          size="driving"
        />
        <View style={styles.secondaryActions}>
          <SecondaryAction
            icon={{
              android: saved ? 'bookmark' : 'bookmark_border',
              ios: saved ? 'bookmark.fill' : 'bookmark',
            }}
            label={saved ? 'Saved' : 'Save'}
            onPress={onSave}
            selected={saved}
          />
          {onCall !== undefined && (
            <SecondaryAction
              icon={{ android: 'call', ios: 'phone.fill' }}
              label="Call"
              onPress={onCall}
            />
          )}
          <SecondaryAction
            icon={{ android: 'share', ios: 'square.and.arrow.up' }}
            label="Share"
            onPress={onShare}
          />
          {onFindParking !== undefined && (
            <SecondaryAction
              accessibilityHint="Searches for parking near this place"
              icon={{ android: 'local_parking', ios: 'parkingsign.circle.fill' }}
              label="Parking"
              onPress={onFindParking}
            />
          )}
        </View>
      </View>

      <BottomSheetReveal above={(detents.values[0] ?? 0) - 24} style={styles.reveal}>
        <BottomSheetScrollView
          contentContainerStyle={[
            styles.details,
            { paddingBottom: Math.max(metrics.bottomInset + space.md, space.xxl) },
          ]}
        >
          {loading && <StateView title="Loading place details" visual="loading" />}
          {details?.address !== undefined && (
            <ListRow
              icon={{ android: 'location_on', ios: 'mappin.and.ellipse' }}
              iconTint={colors.textSecondary}
              title={details.address}
              titleLines={3}
            />
          )}
          {openingHours !== undefined && (
            <ListRow
              icon={{ android: 'schedule', ios: 'clock' }}
              iconTint={
                openStatus === undefined
                  ? colors.textSecondary
                  : openStatusColor(openStatus, colors)
              }
              subtitle={openStatus === undefined ? undefined : openingHours}
              subtitleLines={4}
              title={openStatus === undefined ? openingHours : placeOpenStatusLabel(openStatus)}
              titleLines={4}
            />
          )}
          {details?.phone !== undefined && onCall !== undefined && (
            <ListRow
              accessibilityLabel={details.phone}
              accessibilityRole="link"
              icon={{ android: 'call', ios: 'phone.fill' }}
              iconTint={colors.textSecondary}
              onPress={onCall}
              title={details.phone}
              trailing="external"
            />
          )}
          {details?.website !== undefined && onWebsite !== undefined && (
            <ListRow
              accessibilityLabel={websiteLabel ?? 'Website from OpenStreetMap'}
              accessibilityRole="link"
              icon={{ android: 'language', ios: 'safari' }}
              iconTint={colors.textSecondary}
              onPress={onWebsite}
              title={websiteLabel ?? 'Website from OpenStreetMap'}
              trailing="external"
            />
          )}
          {details?.wheelchair !== undefined && (
            <ListRow
              icon={{ android: 'accessible', ios: 'figure.roll' }}
              iconTint={colors.textSecondary}
              title={wheelchairLabel(details.wheelchair)}
              titleLines={2}
            />
          )}
          {!loading && details === undefined && (
            <ListRow
              icon={{ android: 'location_on', ios: 'mappin.and.ellipse' }}
              iconTint={colors.textSecondary}
              subtitle="No additional place details are available right now."
              title={`${place.center.latitude.toFixed(5)}, ${place.center.longitude.toFixed(5)}`}
            />
          )}
          {place.category === 'poi' && (
            <View style={styles.ratingSection}>
              <Text accessibilityRole="header" style={styles.ratingTitle}>
                Photos & reviews
              </Text>
              {ratingAvailable ? (
                <GooglePlaceRating
                  latitude={place.center.latitude}
                  longitude={place.center.longitude}
                  name={place.name}
                  style={styles.ratingView}
                />
              ) : (
                <Text style={styles.ratingUnavailable}>
                  Google photos, ratings, and reviews are unavailable in this build
                </Text>
              )}
              <ListRow
                accessibilityHint="Opens Google Maps; the place query is shared only after you choose this action"
                accessibilityLabel="More reviews on Google Maps"
                accessibilityRole="link"
                onPress={onReadReviews}
                title="More reviews on Google Maps"
                trailing="external"
              />
            </View>
          )}
          <Text style={styles.source}>Place data from OpenStreetMap contributors</Text>
        </BottomSheetScrollView>
      </BottomSheetReveal>
    </BottomSheet>
  );
}

const useStyles = createThemedStyles(({ colors }) =>
  StyleSheet.create({
    actions: { gap: space.md - 2, paddingBottom: space.md, paddingHorizontal: space.lg },
    details: { gap: space.xs, paddingHorizontal: space.sm },
    ratingSection: {
      borderTopColor: colors.border,
      borderTopWidth: StyleSheet.hairlineWidth,
      gap: space.sm,
      marginHorizontal: space.sm,
      marginTop: space.md,
      paddingTop: space.lg,
    },
    ratingTitle: { ...typography.title3, color: colors.text },
    ratingUnavailable: { ...typography.footnote, color: colors.textSecondary },
    ratingView: { minHeight: 264, width: '100%' },
    reveal: { flex: 1 },
    secondaryAction: {
      alignItems: 'center',
      backgroundColor: colors.surfaceSunken,
      borderCurve: 'continuous',
      borderRadius: radius.lg,
      flex: 1,
      gap: 3,
      height: 56,
      justifyContent: 'center',
    },
    secondaryActionLabel: { ...typography.caption, color: colors.text, fontSize: 13 },
    secondaryActionSelected: { backgroundColor: colors.primarySoft },
    secondaryActions: { flexDirection: 'row', gap: space.sm },
    source: {
      ...typography.caption,
      color: colors.textTertiary,
      paddingHorizontal: space.sm,
      paddingTop: space.lg,
    },
  }),
);
