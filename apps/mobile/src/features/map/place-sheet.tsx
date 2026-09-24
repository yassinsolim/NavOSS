import type { SearchResult } from '@navoss/contracts';
import { SymbolView } from 'expo-symbols';
import { useEffect, useState, type ComponentProps } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import Animated, {
  FadeIn,
  FadeInUp,
  FadeOut,
  FadeOutDown,
  LinearTransition,
  ReduceMotion,
} from 'react-native-reanimated';

import { NavOssColors, NavOssFonts } from '@/constants/navoss-theme';
import { Spacing } from '@/constants/theme';
import { GooglePlaceRating } from '@/features/map/google-place-rating';
import {
  placeOpenStatus,
  placeOpenStatusLabel,
  type PlaceOpenStatus,
} from '@/features/map/map-place';
import { categoryLabel } from '@/features/map/search-result-category';
import { searchResultContext } from '@/features/map/search-proximity';

type SymbolName = ComponentProps<typeof SymbolView>['name'];

interface PlaceSheetProps {
  bottomInset: number;
  height: number;
  loading: boolean;
  onCall?: () => void;
  onClose: () => void;
  onDirections: () => void;
  onFindParking?: () => void;
  onReadReviews: () => void;
  onSave: () => void;
  onShare: () => void;
  onWebsite?: () => void;
  place: SearchResult;
  ratingAvailable: boolean;
  saved: boolean;
  websiteLabel?: string;
}

function displayCategory(value: string): string {
  return value
    .split('_')
    .map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
    .join(' ');
}

function wheelchairLabel(value: string): string {
  if (value === 'yes') return 'Wheelchair access available';
  if (value === 'limited') return 'Limited wheelchair access';
  if (value === 'no') return 'No wheelchair access indicated';
  return `Wheelchair access: ${displayCategory(value)}`;
}

function PlaceAction({
  accessibilityHint,
  icon,
  label,
  onPress,
  primary = false,
  selected,
}: {
  accessibilityHint?: string;
  icon: SymbolName;
  label: string;
  onPress: () => void;
  primary?: boolean;
  selected?: boolean;
}) {
  return (
    <Animated.View
      entering={FadeIn.duration(160).reduceMotion(ReduceMotion.System)}
      layout={LinearTransition.duration(160).reduceMotion(ReduceMotion.System)}
      style={styles.action}
    >
      <Pressable
        accessibilityHint={accessibilityHint}
        accessibilityLabel={label}
        accessibilityRole="button"
        accessibilityState={selected === undefined ? undefined : { selected }}
        onPress={onPress}
        style={({ pressed }) => [styles.actionPressable, pressed && styles.pressed]}
      >
        <View
          style={[
            styles.actionIcon,
            selected && styles.selectedActionIcon,
            primary && styles.primaryActionIcon,
          ]}
        >
          <SymbolView
            name={icon}
            size={23}
            tintColor={primary ? NavOssColors.paper : NavOssColors.green}
          />
        </View>
        <Text numberOfLines={2} style={[styles.actionLabel, primary && styles.primaryActionLabel]}>
          {label}
        </Text>
      </Pressable>
    </Animated.View>
  );
}

function DetailRow({
  icon,
  label,
  onPress,
  statusColor,
}: {
  icon: SymbolName;
  label: string;
  onPress?: () => void;
  statusColor?: string;
}) {
  const content = (
    <>
      <View style={styles.detailIcon}>
        <SymbolView name={icon} size={19} tintColor={NavOssColors.muted} />
      </View>
      {statusColor !== undefined && (
        <View style={[styles.detailStatusDot, { backgroundColor: statusColor }]} />
      )}
      <Text style={[styles.detailText, onPress && styles.detailLink]}>{label}</Text>
      {onPress !== undefined && (
        <SymbolView
          name={{ android: 'open_in_new', ios: 'arrow.up.right' }}
          size={14}
          tintColor={NavOssColors.green}
        />
      )}
    </>
  );

  return onPress === undefined ? (
    <View style={styles.detailRow}>{content}</View>
  ) : (
    <Pressable
      accessibilityLabel={label}
      accessibilityRole="link"
      onPress={onPress}
      style={({ pressed }) => [styles.detailRow, pressed && styles.detailRowPressed]}
    >
      {content}
    </Pressable>
  );
}

function openStatusColor(status: PlaceOpenStatus): string {
  if (status === 'open') return NavOssColors.green;
  if (status === 'closing-soon') return NavOssColors.sun;
  return NavOssColors.coral;
}

export function PlaceSheet({
  bottomInset,
  height,
  loading,
  onCall,
  onClose,
  onDirections,
  onFindParking,
  onReadReviews,
  onSave,
  onShare,
  onWebsite,
  place,
  ratingAvailable,
  saved,
  websiteLabel,
}: PlaceSheetProps) {
  const details = place.details;
  const category = categoryLabel(place, undefined) || searchResultContext(place);
  const [now, setNow] = useState(() => new Date());
  const openStatus = details?.openingHours === undefined ? undefined : placeOpenStatus(place, now);
  const openingHoursLabel =
    details?.openingHours === undefined
      ? undefined
      : openStatus === undefined
        ? details.openingHours
        : `${placeOpenStatusLabel(openStatus)} · ${details.openingHours}`;
  const openingHours = details?.openingHours;

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
    <Animated.View
      entering={FadeInUp.duration(200).reduceMotion(ReduceMotion.System)}
      exiting={FadeOutDown.duration(180).reduceMotion(ReduceMotion.System)}
      layout={LinearTransition.duration(200).reduceMotion(ReduceMotion.System)}
      style={[styles.panel, { height }]}
    >
      <View style={styles.handle} />
      <View style={styles.header}>
        <View style={styles.titleCopy}>
          <Text accessibilityRole="header" numberOfLines={2} style={styles.title}>
            {place.name}
          </Text>
          <Text numberOfLines={2} style={styles.category}>
            {category}
          </Text>
        </View>
        <Pressable
          accessibilityLabel="Close place details"
          accessibilityRole="button"
          hitSlop={8}
          onPress={onClose}
          style={({ pressed }) => [styles.closeButton, pressed && styles.pressed]}
        >
          <SymbolView
            name={{ android: 'close', ios: 'xmark' }}
            size={19}
            tintColor={NavOssColors.asphalt}
          />
        </Pressable>
      </View>

      <View style={styles.actions}>
        <PlaceAction
          icon={{ android: 'directions', ios: 'arrow.triangle.turn.up.right.diamond.fill' }}
          label="Directions"
          onPress={onDirections}
          primary
        />
        <PlaceAction
          icon={{
            android: saved ? 'bookmark' : 'bookmark_border',
            ios: saved ? 'bookmark.fill' : 'bookmark',
          }}
          label={saved ? 'Saved' : 'Save'}
          onPress={onSave}
          selected={saved}
        />
        {onCall !== undefined && (
          <PlaceAction
            icon={{ android: 'call', ios: 'phone.fill' }}
            label="Call"
            onPress={onCall}
          />
        )}
        <PlaceAction
          icon={{ android: 'share', ios: 'square.and.arrow.up' }}
          label="Share"
          onPress={onShare}
        />
        {onFindParking !== undefined && (
          <PlaceAction
            icon={{ android: 'local_parking', ios: 'parkingsign.circle.fill' }}
            label="Parking"
            onPress={onFindParking}
          />
        )}
      </View>

      <ScrollView
        contentContainerStyle={[styles.details, { paddingBottom: Math.max(bottomInset + 12, 24) }]}
        showsVerticalScrollIndicator={false}
      >
        {loading && (
          <Animated.View
            accessibilityLiveRegion="polite"
            entering={FadeIn.duration(160).reduceMotion(ReduceMotion.System)}
            exiting={FadeOut.duration(120).reduceMotion(ReduceMotion.System)}
            style={styles.loadingRow}
          >
            <ActivityIndicator color={NavOssColors.green} size="small" />
            <Text style={styles.loadingText}>Loading place details</Text>
          </Animated.View>
        )}
        {details?.address !== undefined && (
          <DetailRow
            icon={{ android: 'location_on', ios: 'mappin.and.ellipse' }}
            label={details.address}
          />
        )}
        {details?.openingHours !== undefined && (
          <DetailRow
            icon={{ android: 'schedule', ios: 'clock' }}
            label={openingHoursLabel ?? details.openingHours}
            statusColor={openStatus === undefined ? undefined : openStatusColor(openStatus)}
          />
        )}
        {details?.phone !== undefined && onCall !== undefined && (
          <DetailRow
            icon={{ android: 'call', ios: 'phone.fill' }}
            label={details.phone}
            onPress={onCall}
          />
        )}
        {details?.website !== undefined && onWebsite !== undefined && (
          <DetailRow
            icon={{ android: 'language', ios: 'safari' }}
            label={websiteLabel === undefined ? 'Website from OpenStreetMap' : websiteLabel}
            onPress={onWebsite}
          />
        )}
        {details?.wheelchair !== undefined && (
          <DetailRow
            icon={{ android: 'accessible', ios: 'figure.roll' }}
            label={wheelchairLabel(details.wheelchair)}
          />
        )}
        {!loading && details === undefined && (
          <DetailRow
            icon={{ android: 'location_on', ios: 'mappin.and.ellipse' }}
            label={`${place.center.latitude.toFixed(5)}, ${place.center.longitude.toFixed(5)}`}
          />
        )}
        {!loading && details === undefined && (
          <Text style={styles.detailsUnavailable}>
            No additional place details are available right now.
          </Text>
        )}
        {place.category === 'poi' && (
          <View style={styles.ratingSection}>
            <View style={styles.ratingHeading}>
              <SymbolView
                name={{ android: 'star', ios: 'star.fill' }}
                size={19}
                tintColor={NavOssColors.sun}
              />
              <Text style={styles.ratingTitle}>Photos & reviews</Text>
            </View>
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
            <Pressable
              accessibilityHint="Opens Google Maps; the place query is shared only after you choose this action"
              accessibilityLabel="More reviews on Google Maps"
              accessibilityRole="link"
              onPress={onReadReviews}
              style={({ pressed }) => [styles.reviewsLink, pressed && styles.pressed]}
            >
              <Text style={styles.reviewsLinkText}>More reviews on Google Maps</Text>
              <SymbolView
                name={{ android: 'open_in_new', ios: 'arrow.up.right' }}
                size={14}
                tintColor={NavOssColors.green}
              />
            </Pressable>
          </View>
        )}
        <Text style={styles.source}>Place data from OpenStreetMap contributors</Text>
      </ScrollView>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  action: {
    flex: 1,
    minHeight: 88,
    minWidth: Spacing.six,
  },
  actionPressable: {
    alignItems: 'center',
    borderRadius: Spacing.two,
    flex: 1,
    gap: Spacing.two,
    justifyContent: 'flex-start',
    width: '100%',
  },
  actionIcon: {
    alignItems: 'center',
    backgroundColor: NavOssColors.fog,
    borderRadius: 24,
    height: 48,
    justifyContent: 'center',
    width: 48,
  },
  actionLabel: {
    color: NavOssColors.asphalt,
    fontFamily: NavOssFonts.medium,
    fontSize: 14,
    letterSpacing: 0,
    lineHeight: 20,
    textAlign: 'center',
  },
  actions: {
    borderBottomColor: NavOssColors.border,
    borderBottomWidth: StyleSheet.hairlineWidth,
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: Spacing.one,
    paddingBottom: Spacing.three,
    paddingHorizontal: Spacing.three,
    paddingTop: Spacing.one,
  },
  category: {
    color: NavOssColors.muted,
    fontFamily: NavOssFonts.regular,
    fontSize: 14,
    letterSpacing: 0,
    lineHeight: 20,
  },
  closeButton: {
    alignItems: 'center',
    backgroundColor: NavOssColors.fog,
    borderRadius: Spacing.four,
    height: 44,
    justifyContent: 'center',
    width: 44,
  },
  detailIcon: {
    alignItems: 'center',
    width: 28,
  },
  detailLink: {
    color: NavOssColors.green,
    fontFamily: NavOssFonts.medium,
  },
  detailRow: {
    alignItems: 'center',
    borderBottomColor: NavOssColors.border,
    borderBottomWidth: StyleSheet.hairlineWidth,
    flexDirection: 'row',
    gap: Spacing.two,
    minHeight: 48,
    paddingVertical: Spacing.two,
  },
  detailRowPressed: {
    backgroundColor: NavOssColors.fog,
  },
  detailStatusDot: {
    borderRadius: 4,
    height: 8,
    width: 8,
  },
  detailText: {
    color: NavOssColors.asphalt,
    flex: 1,
    fontFamily: NavOssFonts.regular,
    fontSize: 16,
    letterSpacing: 0,
    lineHeight: 24,
  },
  details: {
    paddingBottom: Spacing.four,
    paddingHorizontal: Spacing.three,
  },
  detailsUnavailable: {
    color: NavOssColors.muted,
    fontFamily: NavOssFonts.regular,
    fontSize: 14,
    lineHeight: 20,
    paddingVertical: Spacing.two,
  },
  handle: {
    alignSelf: 'center',
    backgroundColor: NavOssColors.border,
    borderRadius: 2,
    height: 4,
    marginTop: 8,
    width: Spacing.five + Spacing.two,
  },
  header: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: Spacing.two,
    minHeight: 80,
    paddingHorizontal: Spacing.three,
    paddingVertical: Spacing.two,
  },
  loadingRow: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: Spacing.two,
    minHeight: 48,
  },
  loadingText: {
    color: NavOssColors.muted,
    flex: 1,
    fontFamily: NavOssFonts.regular,
    fontSize: 14,
    letterSpacing: 0,
    lineHeight: 20,
  },
  panel: {
    backgroundColor: NavOssColors.paper,
    borderTopColor: NavOssColors.border,
    borderTopLeftRadius: Spacing.three,
    borderTopRightRadius: Spacing.three,
    borderTopWidth: StyleSheet.hairlineWidth,
    bottom: 0,
    left: 0,
    position: 'absolute',
    right: 0,
    shadowColor: NavOssColors.asphalt,
    shadowOffset: { height: -Spacing.one, width: 0 },
    shadowOpacity: 0.12,
    shadowRadius: 12,
  },
  pressed: {
    opacity: 0.8,
  },
  primaryActionIcon: {
    backgroundColor: NavOssColors.green,
  },
  primaryActionLabel: {
    color: NavOssColors.green,
    fontFamily: NavOssFonts.bold,
  },
  selectedActionIcon: {
    backgroundColor: NavOssColors.sky,
  },
  ratingHeading: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: Spacing.two,
  },
  ratingSection: {
    borderBottomColor: NavOssColors.border,
    borderBottomWidth: StyleSheet.hairlineWidth,
    gap: Spacing.two,
    paddingBottom: Spacing.three,
    paddingTop: Spacing.three,
  },
  ratingTitle: {
    color: NavOssColors.asphalt,
    fontFamily: NavOssFonts.semibold,
    fontSize: 16,
    letterSpacing: 0,
  },
  ratingUnavailable: {
    color: NavOssColors.muted,
    fontFamily: NavOssFonts.regular,
    fontSize: 14,
    letterSpacing: 0,
    lineHeight: 20,
  },
  ratingView: {
    alignSelf: 'stretch',
    minHeight: 320,
  },
  reviewsLink: {
    alignItems: 'center',
    alignSelf: 'flex-start',
    flexDirection: 'row',
    gap: Spacing.two,
    minHeight: 44,
  },
  reviewsLinkText: {
    color: NavOssColors.green,
    fontFamily: NavOssFonts.semibold,
    fontSize: 14,
    letterSpacing: 0,
  },
  source: {
    color: NavOssColors.muted,
    fontFamily: NavOssFonts.regular,
    fontSize: 12,
    letterSpacing: 0,
    lineHeight: 16,
    paddingTop: Spacing.three,
  },
  title: {
    color: NavOssColors.asphalt,
    fontFamily: NavOssFonts.bold,
    fontSize: 22,
    letterSpacing: 0,
    lineHeight: 28,
  },
  titleCopy: {
    flex: 1,
    gap: Spacing.one,
    minWidth: 0,
  },
});
