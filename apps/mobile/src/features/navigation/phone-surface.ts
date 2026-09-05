export type PhoneRouteStatus = 'arrived' | 'error' | 'idle' | 'loading' | 'navigating' | 'preview';

export type PhoneSurface = 'arrival' | 'carplay-idle' | 'guidance' | 'map';

export interface PhoneSurfaceInput {
  carPlayConnected: boolean;
  /// Whether a maneuver, remaining route, and remaining step are all resolved. Guidance renders
  /// distance and instruction from all three, so a partial snapshot cannot drive that surface.
  guidanceResolved: boolean;
  routeStatus: PhoneRouteStatus;
}

/// Which surface the handset shows.
///
/// While CarPlay is connected the phone never renders a map. The car display owns the driving
/// surface, and a second MapLibre view on the handset renders a screen the driver should not be
/// looking at. Every connected state therefore resolves to a companion.
export function phoneSurface({
  carPlayConnected,
  guidanceResolved,
  routeStatus,
}: PhoneSurfaceInput): PhoneSurface {
  if (!carPlayConnected) return 'map';
  if (routeStatus === 'arrived') return 'arrival';
  if (routeStatus === 'navigating' && guidanceResolved) return 'guidance';
  return 'carplay-idle';
}
