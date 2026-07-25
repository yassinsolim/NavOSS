import { requireNativeView } from 'expo';
import type { StyleProp, ViewStyle } from 'react-native';

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
  return (
    <NativeGooglePlaceRatingView
      latitude={latitude}
      longitude={longitude}
      name={name}
      style={style}
    />
  );
}
