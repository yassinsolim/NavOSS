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
}

/**
 * Google's own place details, kept apart from the OpenStreetMap details above it. Each open first
 * takes an anonymous grant from the NavOSS server's monthly counter, then Google's component
 * fetches and renders the place live. When Google has no matching place the section disappears
 * and says nothing about Google.
 */
export function GooglePlaceDetailsSection({
  available,
  latitude,
  longitude,
  name,
  onReadReviews,
}: GooglePlaceDetailsSectionProps) {
  const styles = useStyles();
  const { height: windowHeight } = useWindowDimensions();
  const grantKey = `${name}:${latitude}:${longitude}`;
  const requestRef = useRef<{
    key: string;
    request: Promise<GooglePlaceQueryGrantResponse>;
  } | null>(null);
  const [state, setState] = useState<GooglePlaceDetailsState>('checking');
  const [granted, setGranted] = useState(false);

  useEffect(() => {
    if (!available) return undefined;
    let active = true;
    if (requestRef.current?.key !== grantKey) {
      requestRef.current = { key: grantKey, request: reserveGooglePlaceQuery() };
    }
    setGranted(false);
    setState('checking');
    void requestRef.current.request
      .then((response) => {
        if (!active) return;
        setGranted(response.granted);
        setState(response.granted ? 'loading' : 'unavailable');
      })
      .catch((error: unknown) => {
        if (active) setState(googleGrantFailureState(error));
      });
    return () => {
      active = false;
    };
  }, [available, grantKey]);

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
  const showsGoogle = granted && (state === 'loading' || matched);

  return (
    <View style={styles.section}>
      <Text accessibilityRole="header" maxFontSizeMultiplier={1.5} style={styles.title}>
        Google reviews and details
      </Text>
      {message !== undefined && (
        <StateView
          message={message.message}
          title={message.title}
          visual={
            state === 'checking' || state === 'loading'
              ? 'loading'
              : { android: 'cloud_off', ios: state === 'offline' ? 'wifi.slash' : 'clock' }
          }
        />
      )}
      {showsGoogle && (
        // Google's component loads while collapsed and is shown only once the place matches.
        <View
          style={
            matched
              ? [styles.card, { height: googlePlaceDetailsHeight(windowHeight) }]
              : styles.probe
          }
        >
          <NativeGooglePlaceDetailsView
            latitude={latitude}
            longitude={longitude}
            name={name}
            onStateChange={(event) => {
              setState(nativeGooglePlaceState(event.nativeEvent.state));
            }}
            style={StyleSheet.absoluteFill}
          />
        </View>
      )}
      {state !== 'checking' && state !== 'loading' && reviewsLink}
    </View>
  );
}

const useStyles = createThemedStyles(({ colors }) =>
  StyleSheet.create({
    card: {
      borderColor: colors.border,
      borderCurve: 'continuous',
      borderRadius: radius.lg,
      borderWidth: StyleSheet.hairlineWidth,
      overflow: 'hidden',
    },
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
