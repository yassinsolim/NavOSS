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
  type GoogleLoad,
  GoogleLoadSequencer,
  type GooglePhase,
  settlesGoogleLoad,
  googlePlaceDetailsHeight,
  googlePlaceDetailsMessage,
  type GooglePlaceDetailsState,
  nativeGooglePlaceState,
} from '@/features/map/google-place-details';
import { reserveGooglePlaceQuery } from '@/lib/api';
import { createThemedStyles, space, typography, useTheme } from '@/theme';
import { ListRow } from '@/ui/list-row';
import { StateView } from '@/ui/state-view';

interface NativeGooglePlaceDetailsProps {
  latitude: number;
  longitude: number;
  name: string;
  onStateChange: (event: NativeSyntheticEvent<{ state: string }>) => void;
  /** Moved forward only once a NavOSS grant is held for the next Google component load. */
  phase: GooglePhase;
  /** New for every granted load, so retrying the same phase loads one new component. */
  request: number;
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
 * Google's own place details, kept apart from the OpenStreetMap details above it. Google's panel
 * for the listing nearest the selected coordinate opens automatically when that listing is within
 * a few metres; it shows Google's own name for the listing, and the section says it is Google's
 * nearest listing rather than claiming it is the same business. "Find this place on Google" shows
 * Google's search list for the name nearby, and the driver's pick replaces the panel. Every Google
 * component load first takes an anonymous grant from the NavOSS server's monthly counter.
 */
export function GooglePlaceDetailsSection({
  available,
  latitude,
  longitude,
  name,
  onReadReviews,
}: GooglePlaceDetailsSectionProps) {
  const styles = useStyles();
  const { colors } = useTheme();
  const { height: windowHeight } = useWindowDimensions();
  // PlaceSheet keys this section by the place's identity, so a different name or coordinate
  // remounts it. Each mount's sequencer is retired on unmount, dropping grants still on their way.
  const sequencerRef = useRef<GoogleLoadSequencer | null>(null);
  const [state, setState] = useState<GooglePlaceDetailsState>('checking');
  const [load, setLoad] = useState<GoogleLoad>({ phase: 'idle', request: 0 });
  const phase = load.phase;

  const loadAfterGrant = (next: GooglePhase, sequencer = sequencerRef.current) => {
    // A second tap while a grant or load is in progress spends nothing and changes nothing.
    if (sequencer === null || sequencer.inProgress) return;
    setState('checking');
    void sequencer.begin(next).then((outcome) => {
      if (outcome.kind === 'busy' || outcome.kind === 'stale') return;
      if (outcome.kind === 'load') setLoad(outcome.load);
      else setState(outcome.kind === 'refused' ? 'unavailable' : outcome.state);
    });
  };

  useEffect(() => {
    if (!available) return undefined;
    const sequencer = new GoogleLoadSequencer(() => reserveGooglePlaceQuery());
    sequencerRef.current = sequencer;
    loadAfterGrant('nearest', sequencer);
    return () => {
      sequencer.retire();
      if (sequencerRef.current === sequencer) sequencerRef.current = null;
    };
  }, [available]);

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

  const message = googlePlaceDetailsMessage(state);
  const showsGoogle = state === 'matched' || state === 'searchReady';
  const busy = state === 'checking' || state === 'loading' || state === 'picked';
  const failed = state === 'offline' || state === 'unavailable';
  const caption =
    state === 'searchReady'
      ? 'Choose the Google listing that matches this place.'
      : state === 'matched' && phase === 'picked'
        ? 'The Google listing you chose.'
        : state === 'matched'
          ? "Google's listing nearest this spot. Check the name: it may be a neighbouring business."
          : undefined;
  const canSearch =
    !busy &&
    !failed &&
    state !== 'searchReady' &&
    (phase === 'nearest' || phase === 'picked' || state === 'searchEmpty');

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
            busy
              ? 'loading'
              : {
                  android: 'cloud_off',
                  ios:
                    state === 'offline'
                      ? 'wifi.slash'
                      : state === 'unavailable'
                        ? 'clock'
                        : 'mappin.slash',
                }
          }
        />
      )}
      {caption !== undefined && (
        <Text maxFontSizeMultiplier={1.5} style={styles.note}>
          {caption}
        </Text>
      )}
      {/* One native view in one position: it hosts each Google component in turn. */}
      <View
        style={
          showsGoogle
            ? [styles.card, { height: googlePlaceDetailsHeight(windowHeight) }]
            : styles.probe
        }
      >
        <NativeGooglePlaceDetailsView
          latitude={latitude}
          longitude={longitude}
          name={name}
          onStateChange={(event) => {
            const next = nativeGooglePlaceState(event.nativeEvent.state);
            setState(next);
            if (settlesGoogleLoad(next)) sequencerRef.current?.settle();
            if (next === 'picked') loadAfterGrant('picked');
          }}
          phase={phase}
          request={load.request}
          style={StyleSheet.absoluteFill}
        />
      </View>
      {canSearch && (
        <ListRow
          accessibilityHint="Shows Google's listings for this place's name nearby; sends the name and location to Google"
          accessibilityLabel="Find this place on Google"
          accessibilityRole="button"
          icon={{ android: 'search', ios: 'magnifyingglass' }}
          iconTint={colors.textSecondary}
          onPress={() => {
            loadAfterGrant('search');
          }}
          title="Find this place on Google"
          titleLines={2}
        />
      )}
      {failed && reviewsLink}
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
