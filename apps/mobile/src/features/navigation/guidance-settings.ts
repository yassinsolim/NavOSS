import type { NativeRerouteMode, NavigationAudioMode } from './native-navigation';

export interface GuidanceSettings {
  audioMode: NavigationAudioMode;
  rerouteMode: NativeRerouteMode;
  /** Speak the limit when the speed exceeds it by more than the tolerance. */
  speedingAudibleWarning: boolean;
  /** km/h over the posted limit before the speed shows as over the limit. */
  speedingToleranceKph: number;
}

/** The navigation core's own defaults, used until it reports stored preferences. */
export const DEFAULT_GUIDANCE_SETTINGS: GuidanceSettings = {
  audioMode: 'all-guidance',
  rerouteMode: 'adaptive',
  speedingAudibleWarning: false,
  speedingToleranceKph: 5,
};

export const SPEEDING_TOLERANCES_KPH = [0, 5, 10, 15, 20] as const;

/** Reads the preferences a native payload carries, keeping current values for absent fields. */
export function guidanceSettingsFromNative(
  current: GuidanceSettings,
  native: {
    audioMode?: NavigationAudioMode;
    rerouteMode?: NativeRerouteMode;
    speedingAudibleWarning?: boolean;
    speedingToleranceKph?: number;
  },
): GuidanceSettings {
  return {
    audioMode: native.audioMode ?? current.audioMode,
    rerouteMode: native.rerouteMode ?? current.rerouteMode,
    speedingAudibleWarning: native.speedingAudibleWarning ?? current.speedingAudibleWarning,
    speedingToleranceKph: native.speedingToleranceKph ?? current.speedingToleranceKph,
  };
}

/** What each off-route behaviour does, in the driver's terms. */
export function rerouteModeDescription(mode: NativeRerouteMode): string {
  switch (mode) {
    case 'adaptive':
      return 'If you leave the route, NavOSS switches to the fastest new route automatically.';
    case 'ask-first':
      return 'If you leave the route, NavOSS offers a new route and waits for you. It applies on its own only if you stay off route without answering.';
    case 'keep-route':
      return 'If you leave the route, NavOSS guides you back onto the route you chose.';
  }
}

export interface SpeedReadout {
  accessibilityLabel: string;
  limitKph: number | undefined;
  /** True only when the navigation core has confirmed the speed is over limit plus tolerance. */
  overLimit: boolean;
  speedKph: number | undefined;
}

/**
 * What the speed badge shows. Speed and limit come straight from the navigation core; either
 * can be absent (no fix yet, or no posted limit in the route data) and is then simply not shown.
 */
export function speedReadout({
  speedLimitKph,
  speedMetersPerSecond,
  speedingState,
}: {
  speedLimitKph?: number;
  speedMetersPerSecond?: number;
  speedingState?: 'over-limit' | 'unknown' | 'within-limit';
}): SpeedReadout | undefined {
  const speedKph =
    speedMetersPerSecond !== undefined &&
    Number.isFinite(speedMetersPerSecond) &&
    speedMetersPerSecond >= 0
      ? Math.round(speedMetersPerSecond * 3.6)
      : undefined;
  const limitKph = speedLimitKph !== undefined && speedLimitKph > 0 ? speedLimitKph : undefined;
  if (speedKph === undefined && limitKph === undefined) return undefined;
  const overLimit = speedingState === 'over-limit' && speedKph !== undefined;
  const parts = [
    speedKph === undefined ? undefined : `Speed ${String(speedKph)} kilometres per hour`,
    limitKph === undefined ? undefined : `limit ${String(limitKph)}`,
    overLimit ? 'over the limit' : undefined,
  ].filter((part) => part !== undefined);
  return { accessibilityLabel: parts.join(', '), limitKph, overLimit, speedKph };
}

/** "3 min slower · 1.2 km longer", or "Same time and distance" when the deltas round away. */
export function rerouteDeltaLabel(
  durationDeltaSeconds: number,
  distanceDeltaMeters: number,
): string {
  const minutes = Math.round(durationDeltaSeconds / 60);
  const kilometres = Math.round(distanceDeltaMeters / 100) / 10;
  const parts = [
    minutes === 0
      ? undefined
      : `${String(Math.abs(minutes))} min ${minutes > 0 ? 'slower' : 'faster'}`,
    kilometres === 0
      ? undefined
      : `${Math.abs(kilometres).toFixed(1)} km ${kilometres > 0 ? 'longer' : 'shorter'}`,
  ].filter((part) => part !== undefined);
  return parts.length === 0 ? 'Same time and distance' : parts.join(' · ');
}
