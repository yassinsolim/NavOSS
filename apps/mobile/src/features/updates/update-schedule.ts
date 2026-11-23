/** What the updater remembers between launches. Nothing here identifies the device. */
export interface UpdatePreferences {
  /** "Check for updates automatically"; on by default. */
  autoCheck: boolean;
  /** When "Later" was chosen, and for which version. */
  dismissedAt?: number;
  dismissedVersionCode?: number;
  /** When the last check was attempted, whatever its result. */
  lastCheckAt?: number;
  /** The version the last check offered; its partial download is kept for resuming. */
  offeredVersionCode?: number;
}

export const DEFAULT_UPDATE_PREFERENCES: UpdatePreferences = { autoCheck: true };

export const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

export function normalizeUpdatePreferences(value: unknown): UpdatePreferences {
  if (typeof value !== 'object' || value === null) return DEFAULT_UPDATE_PREFERENCES;
  const record = value as Record<string, unknown>;
  return {
    autoCheck: typeof record.autoCheck === 'boolean' ? record.autoCheck : true,
    dismissedAt: finiteNumber(record.dismissedAt),
    dismissedVersionCode: finiteNumber(record.dismissedVersionCode),
    lastCheckAt: finiteNumber(record.lastCheckAt),
    offeredVersionCode: finiteNumber(record.offeredVersionCode),
  };
}

/**
 * Whether the app may check on its own now: switched on, not during a trip, and at most once per
 * 24 hours. A last check dated in the future (the clock was changed) counts as due.
 */
export function isAutomaticCheckDue(
  preferences: UpdatePreferences,
  now: number,
  tripActive: boolean,
): boolean {
  if (!preferences.autoCheck || tripActive) return false;
  const last = preferences.lastCheckAt;
  if (last === undefined || last > now) return true;
  return now - last >= CHECK_INTERVAL_MS;
}

/**
 * "Later" hides the notice for that version until the next day; a newer version shows at once.
 * Nothing is shown during a trip.
 */
export function isNoticeSnoozed(
  preferences: UpdatePreferences,
  versionCode: number,
  now: number,
): boolean {
  const { dismissedAt, dismissedVersionCode } = preferences;
  if (dismissedAt === undefined || dismissedVersionCode === undefined) return false;
  if (versionCode > dismissedVersionCode) return false;
  if (dismissedAt > now) return false;
  return now - dismissedAt < CHECK_INTERVAL_MS;
}
