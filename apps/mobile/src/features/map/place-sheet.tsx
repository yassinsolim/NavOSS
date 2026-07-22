import type { SearchResult } from '@navoss/contracts';
import { SymbolView } from 'expo-symbols';
import type { ComponentProps } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { NavOssColors, NavOssFonts } from '@/constants/navoss-theme';

type SymbolName = ComponentProps<typeof SymbolView>['name'];

interface PlaceSheetProps {
  bottomInset: number;
  height: number;
  loading: boolean;
  onCall?: () => void;
  onClose: () => void;
  onDirections: () => void;
  onReviews: () => void;
  onShare: () => void;
  onWebsite?: () => void;
  place: SearchResult;
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
}: {
  accessibilityHint?: string;
  icon: SymbolName;
  label: string;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityHint={accessibilityHint}
      accessibilityLabel={label}
      onPress={onPress}
      style={({ pressed }) => [styles.action, pressed && styles.pressed]}
    >
      <View style={styles.actionIcon}>
        <SymbolView name={icon} size={23} tintColor={NavOssColors.green} />
      </View>
      <Text numberOfLines={1} style={styles.actionLabel}>
        {label}
      </Text>
    </Pressable>
  );
}

function DetailRow({
  icon,
  label,
  onPress,
}: {
  icon: SymbolName;
  label: string;
  onPress?: () => void;
}) {
  const content = (
    <>
      <View style={styles.detailIcon}>
        <SymbolView name={icon} size={19} tintColor={NavOssColors.muted} />
      </View>
      <Text numberOfLines={2} style={[styles.detailText, onPress && styles.detailLink]}>
        {label}
      </Text>
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
      onPress={onPress}
      style={({ pressed }) => [styles.detailRow, pressed && styles.detailRowPressed]}
    >
      {content}
    </Pressable>
  );
}

export function PlaceSheet({
  bottomInset,
  height,
  loading,
  onCall,
  onClose,
  onDirections,
  onReviews,
  onShare,
  onWebsite,
  place,
  websiteLabel,
}: PlaceSheetProps) {
  const details = place.details;
  const category = displayCategory(details?.category ?? place.label);

  return (
    <View style={[styles.panel, { height }]}>
      <View style={styles.handle} />
      <View style={styles.header}>
        <View style={styles.titleCopy}>
          <Text numberOfLines={1} style={styles.title}>
            {place.name}
          </Text>
          <Text numberOfLines={1} style={styles.category}>
            {category}
          </Text>
        </View>
        <Pressable
          accessibilityLabel="Close place details"
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
        />
        <PlaceAction
          icon={{ android: 'share', ios: 'square.and.arrow.up' }}
          label="Share"
          onPress={onShare}
        />
        <PlaceAction
          accessibilityHint="Opens Google Maps; the place query is shared only after you choose this action"
          icon={{ android: 'star', ios: 'star.fill' }}
          label="Reviews"
          onPress={onReviews}
        />
      </View>

      <ScrollView
        contentContainerStyle={[styles.details, { paddingBottom: Math.max(bottomInset + 12, 24) }]}
        showsVerticalScrollIndicator={false}
      >
        {loading && (
          <View accessibilityLiveRegion="polite" style={styles.loadingRow}>
            <ActivityIndicator color={NavOssColors.green} size="small" />
            <Text style={styles.loadingText}>Loading open place details</Text>
          </View>
        )}
        {details?.address !== undefined && (
          <DetailRow
            icon={{ android: 'location_on', ios: 'mappin.and.ellipse' }}
            label={details.address}
          />
        )}
        {details?.openingHours !== undefined && (
          <DetailRow icon={{ android: 'schedule', ios: 'clock' }} label={details.openingHours} />
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
        <Text style={styles.source}>Place data from OpenStreetMap contributors</Text>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  action: {
    alignItems: 'center',
    flex: 1,
    gap: 6,
    minWidth: 72,
  },
  actionIcon: {
    alignItems: 'center',
    backgroundColor: NavOssColors.sky,
    borderRadius: 24,
    height: 48,
    justifyContent: 'center',
    width: 48,
  },
  actionLabel: {
    color: NavOssColors.asphalt,
    fontFamily: NavOssFonts.medium,
    fontSize: 13,
    letterSpacing: 0,
  },
  actions: {
    borderBottomColor: NavOssColors.border,
    borderBottomWidth: StyleSheet.hairlineWidth,
    flexDirection: 'row',
    paddingBottom: 14,
    paddingHorizontal: 24,
    paddingTop: 4,
  },
  category: {
    color: NavOssColors.muted,
    fontFamily: NavOssFonts.regular,
    fontSize: 14,
    letterSpacing: 0,
  },
  closeButton: {
    alignItems: 'center',
    backgroundColor: NavOssColors.fog,
    borderRadius: 19,
    height: 38,
    justifyContent: 'center',
    width: 38,
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
    gap: 9,
    minHeight: 48,
    paddingVertical: 9,
  },
  detailRowPressed: {
    backgroundColor: NavOssColors.fog,
  },
  detailText: {
    color: NavOssColors.asphalt,
    flex: 1,
    fontFamily: NavOssFonts.regular,
    fontSize: 14,
    letterSpacing: 0,
    lineHeight: 19,
  },
  details: {
    paddingBottom: 24,
    paddingHorizontal: 18,
  },
  handle: {
    alignSelf: 'center',
    backgroundColor: NavOssColors.border,
    borderRadius: 2,
    height: 4,
    marginTop: 8,
    width: 38,
  },
  header: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 12,
    minHeight: 70,
    paddingHorizontal: 18,
  },
  loadingRow: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 10,
    minHeight: 48,
  },
  loadingText: {
    color: NavOssColors.muted,
    fontFamily: NavOssFonts.regular,
    fontSize: 14,
    letterSpacing: 0,
  },
  panel: {
    backgroundColor: NavOssColors.white,
    borderTopColor: NavOssColors.border,
    borderTopLeftRadius: 8,
    borderTopRightRadius: 8,
    borderTopWidth: StyleSheet.hairlineWidth,
    bottom: 0,
    left: 0,
    position: 'absolute',
    right: 0,
    shadowColor: '#000000',
    shadowOffset: { height: -3, width: 0 },
    shadowOpacity: 0.16,
    shadowRadius: 12,
  },
  pressed: {
    opacity: 0.7,
    transform: [{ scale: 0.97 }],
  },
  source: {
    color: NavOssColors.muted,
    fontFamily: NavOssFonts.regular,
    fontSize: 11,
    letterSpacing: 0,
    paddingTop: 12,
  },
  title: {
    color: NavOssColors.asphalt,
    fontFamily: NavOssFonts.bold,
    fontSize: 22,
    letterSpacing: 0,
  },
  titleCopy: {
    flex: 1,
    gap: 2,
    minWidth: 0,
  },
});
