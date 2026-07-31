import { requireNativeView } from 'expo';
import { useEffect, useRef, useState } from 'react';
import { StyleSheet, Text, View, type StyleProp, type ViewStyle } from 'react-native';

import { NavOssColors, NavOssFonts } from '@/constants/navoss-theme';
import { reserveGooglePlaceQuery } from '@/lib/api';

interface NativeGooglePlaceRatingProps {
  latitude: number;
  longitude: number;
  name: string;
  style?: StyleProp<ViewStyle>;
}

const NativeGooglePlaceRatingView = requireNativeView<NativeGooglePlaceRatingProps>(
  'NavOSSNavigation',
  'NavOSSGooglePlaceRatingView',
);

export function GooglePlaceRating({
  latitude,
  longitude,
  name,
  style,
}: NativeGooglePlaceRatingProps) {
  const grantKey = `${name}:${latitude}:${longitude}`;
  const requestRef = useRef<{
    key: string;
    request: ReturnType<typeof reserveGooglePlaceQuery>;
  } | null>(null);
  const [granted, setGranted] = useState<boolean>();

  useEffect(() => {
    let active = true;
    if (requestRef.current?.key !== grantKey) {
      requestRef.current = {
        key: grantKey,
        request: reserveGooglePlaceQuery(),
      };
    }
    setGranted(undefined);
    void requestRef.current.request
      .then((response) => {
        if (active) setGranted(response.granted);
      })
      .catch(() => {
        if (active) setGranted(false);
      });

    return () => {
      active = false;
    };
  }, [grantKey]);

  if (granted !== true) {
    return (
      <View style={style}>
        <Text style={styles.availability}>
          {granted === undefined
            ? 'Checking Google details availability'
            : 'Google details are temporarily unavailable'}
        </Text>
      </View>
    );
  }

  return (
    <NativeGooglePlaceRatingView
      latitude={latitude}
      longitude={longitude}
      name={name}
      style={style}
    />
  );
}

const styles = StyleSheet.create({
  availability: {
    color: NavOssColors.muted,
    fontFamily: NavOssFonts.regular,
    fontSize: 14,
    letterSpacing: 0,
  },
});
