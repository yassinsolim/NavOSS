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
/// CarPlay takes over driving guidance after a route starts. Before then, the handset keeps its
/// interactive map so a passenger or parked driver can search, recover a failed plan, and start a
/// route preview without losing access to the controls that exist only on the phone.
export function phoneSurface({
  carPlayConnected,
  guidanceResolved,
  routeStatus,
}: PhoneSurfaceInput): PhoneSurface {
  if (!carPlayConnected) return 'map';
  if (routeStatus === 'arrived') return 'arrival';
  if (routeStatus === 'navigating') return guidanceResolved ? 'guidance' : 'carplay-idle';
  return 'map';
}

/// Whether a phone-side route must be released when the car connects.
///
/// Planning states remain actionable on the connected handset, so connecting must not discard a
/// preview or a plan that can retry or cancel. Keep the choice exhaustive so a new route state
/// cannot silently lose user work.
export function releasesPhoneRouteOnCarPlayConnect(routeStatus: PhoneRouteStatus): boolean {
  switch (routeStatus) {
    case 'arrived':
    case 'error':
    case 'idle':
    case 'loading':
    case 'navigating':
    case 'preview':
      return false;
  }
}
