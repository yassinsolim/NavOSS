import type { GooglePlaceQueryGrantResponse } from '@navoss/contracts';
import { requireNativeView } from 'expo';
import { useEffect, useRef, useState } from 'react';
import {
  type NativeSyntheticEvent,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
  type StyleProp,
  type ViewStyle,
} from 'react-native';

import {
  googleGrantFailureState,
  googlePlaceDetailsHeight,
  googlePlaceDetailsMessage,
  type GooglePlaceDetailsState,
  nativeGooglePlaceState,
} from '@/features/map/google-place-details';
import { reserveGooglePlaceQuery } from '@/lib/api';
import { createThemedStyles, radius, space, typography } from '@/theme';
import { ListRow } from '@/ui/list-row';
import { StateView } from '@/ui/state-view';

interface NativeGooglePlaceDetailsProps {
  latitude: number;
  longitude: number;
  /** Set once a NavOSS grant is held; Google's component loads only then. */
  loadDetails: boolean;
  name: string;
  onStateChange: (event: NativeSyntheticEvent<{ state: string }>) => void;
  style?: StyleProp<ViewStyle>;
}

const NativeGooglePlaceDetailsView = requireNativeView<NativeGooglePlaceDetailsProps>(
  'NavOSSNavigation',
  'NavOSSGooglePlaceRatingView',
);

interface GooglePlaceDetailsSectionProps {
  /** False in builds made without the Google profile. */
  available: boolean;
  latitude: number;
  longitude: number;
  name: string;
  onReadReviews: () => void;
  /** What Google resolves to a place ID: the name and, when known, the street address. */
  searchText: string;
}

/**
 * Google's own place details, kept apart from the OpenStreetMap details above it. Google first
 * resolves the selected name near its coordinate to a place ID (free, no grant). Only a place
 * Google lists takes an anonymous grant from the NavOSS server's monthly counter, and only then
 * does Google's component fetch and render the place live. When Google has no matching place the
 * section disappears and says nothing about Google.
 */
export function GooglePlaceDetailsSection({
  available,
  latitude,
  longitude,
  name,
  onReadReviews,
  searchText,
}: GooglePlaceDetailsSectionProps) {
  const styles = useStyles();
  const { height: windowHeight } = useWindowDimensions();
  const grantKey = `${name}:${latitude}:${longitude}`;
  const requestRef = useRef<{
    key: string;
    request: Promise<GooglePlaceQueryGrantResponse>;
  } | null>(null);
  const [state, setState] = useState<GooglePlaceDetailsState>('resolving');
  const [granted, setGranted] = useState(false);
  // Stays true once Google has listed the place, so moving on to `checking` does not cancel the
  // grant request below.
  const [listed, setListed] = useState(false);

  useEffect(() => {
    if (!available || !listed) return undefined;
    let active = true;
    if (requestRef.current?.key !== grantKey) {
      requestRef.current = { key: grantKey, request: reserveGooglePlaceQuery() };
    }
    setState('checking');
    void requestRef.current.request
      .then((response) => {
        if (!active) return;
        setGranted(response.granted);
        if (!response.granted) setState('unavailable');
      })
      .catch((error: unknown) => {
        if (active) setState(googleGrantFailureState(error));
      });
    return () => {
      active = false;
    };
  }, [available, grantKey, listed]);

  const reviewsLink = (
    <ListRow
      accessibilityHint="Opens Google Maps; the place query is shared only after you choose this action"
      accessibilityLabel="More reviews on Google Maps"
      accessibilityRole="link"
      onPress={onReadReviews}
      title="More reviews on Google Maps"
      titleLines={2}
      trailing="external"
    />
  );

  if (!available) {
    return (
      <View style={styles.section}>
        <Text accessibilityRole="header" maxFontSizeMultiplier={1.5} style={styles.title}>
          Google reviews and details
        </Text>
        <Text maxFontSizeMultiplier={1.5} style={styles.note}>
          Google photos, ratings, and reviews are unavailable in this build
        </Text>
        {reviewsLink}
      </View>
    );
  }

  if (state === 'noMatch') return null;

  const message = googlePlaceDetailsMessage(state);
  const matched = state === 'matched';
  const native = (
    // Mounted while Google resolves and loads; collapsed and hidden until the place matches.
    <View
      key="google"
      style={
        matched ? [styles.card, { height: googlePlaceDetailsHeight(windowHeight) }] : styles.probe
      }
    >
      <NativeGooglePlaceDetailsView
        latitude={latitude}
        loadDetails={granted}
        longitude={longitude}
        name={searchText}
        onStateChange={(event) => {
          const next = nativeGooglePlaceState(event.nativeEvent.state);
          if (next === 'resolved') setListed(true);
          setState(next);
        }}
        style={StyleSheet.absoluteFill}
      />
    </View>
  );

  // Until Google lists the place, say nothing about Google. The native view keeps one position
  // in this tree in every state: remounting it would resolve the place again.
  const resolving = state === 'resolving';
  const busy = state === 'resolved' || state === 'checking' || state === 'loading';
  return (
    <View style={resolving ? undefined : styles.section}>
      {!resolving && (
        <Text accessibilityRole="header" maxFontSizeMultiplier={1.5} style={styles.title}>
          Google reviews and details
        </Text>
      )}
      {message !== undefined && (
        <StateView
          message={message.message}
          title={message.title}
          visual={
            busy
              ? 'loading'
              : { android: 'cloud_off', ios: state === 'offline' ? 'wifi.slash' : 'clock' }
          }
        />
      )}
      {native}
      {/* Google's component has its own "Open in Maps"; the link is the fallback when it is absent. */}
      {!resolving && !busy && !matched && reviewsLink}
    </View>
  );
}

const useStyles = createThemedStyles(({ colors }) =>
  StyleSheet.create({
    // Google's component draws its own outlined card with its attribution header; a second
    // NavOSS border showed as a double line under it on the simulator.
    card: { overflow: 'hidden' },
    note: { ...typography.footnote, color: colors.textSecondary },
    // One point tall and clipped: Google's view is in the window so it can load, but nothing
    // shows until the place matches.
    probe: { height: 1, opacity: 0, overflow: 'hidden' },
    section: {
      borderTopColor: colors.border,
      borderTopWidth: StyleSheet.hairlineWidth,
      gap: space.sm,
      marginHorizontal: space.sm,
      marginTop: space.md,
      paddingTop: space.lg,
    },
    title: { ...typography.title3, color: colors.text },
  }),
);
