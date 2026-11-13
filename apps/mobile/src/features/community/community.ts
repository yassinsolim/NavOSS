import type { FeatureCollection, Point } from 'geojson';

import { ROAD_REPORT_TYPES } from '../map/road-report-drafts';
import { type RouteOriginSample, routeRequestOriginFromSample } from '../navigation/route-origin';
import type {
  NativeCommunityError,
  NativeCommunityReport,
  NativeCommunityReportType,
  NativeCommunityResult,
  NativeCommunityState,
  NativeTrafficSharingState,
} from '@/features/navigation/native-navigation';

/*
 * Community road reports and traffic sharing, as the phone presents them. Everything here is
 * pure: the native bridge owns networking, App Attest and the preferences shared with CarPlay;
 * this module decides what each state means for the driver and says it plainly.
 */

/** The largest box the native fetch accepts, per side, in degrees. */
export const REPORT_FETCH_MAX_SPAN_DEGREES = 0.5;
/** Fetch boxes are snapped to this grid so small pans reuse the native cache. */
export const REPORT_FETCH_GRID_DEGREES = 0.05;
/** Layer the map hit-tests for community reports. */
export const COMMUNITY_REPORT_LAYER_IDS = ['community-reports'] as const;
/** Neither guidance prompt is shown while the next maneuver is this close. */
export const REPORT_AHEAD_MANEUVER_CLEARANCE_METERS = 300;
export const STILL_THERE_MANEUVER_CLEARANCE_METERS = 500;

/**
 * - `checking`: the bridge has not answered yet (nothing is drawn or offered).
 * - `live`: usable.
 * - `not-available`: the server (or this build) does not provide it; nothing is requested.
 * - `unsupported`: the server provides it, but this device cannot sign writes (no App Attest).
 */
export type CommunityFeatureState = 'checking' | 'live' | 'not-available' | 'unsupported';

export interface CommunityAvailability {
  /** Reading and drawing shared reports. */
  reports: CommunityFeatureState;
  /** Sharing reports and answering "Still there?". */
  reportSharing: CommunityFeatureState;
  /** "Share traffic speeds". */
  trafficSharing: CommunityFeatureState;
  /** The community traffic-flow layer. */
  trafficFlow: CommunityFeatureState;
}

const TRAFFIC_STATE_ACCEPTED: Record<NativeTrafficSharingState['state'], boolean> = {
  off: false,
  paused: true,
  ready: false,
  sharing: true,
  'starts-later': true,
  starting: true,
  unavailable: false,
};

export function communityAvailability({
  hasNativeReports,
  hasNativeTraffic,
  serverLiveTraffic,
  state,
}: {
  hasNativeReports: boolean;
  hasNativeTraffic: boolean;
  /** `features.liveTraffic` from the server config; undefined until it arrived. */
  serverLiveTraffic: boolean | undefined;
  state: NativeCommunityState | undefined;
}): CommunityAvailability {
  const reports: CommunityFeatureState = !hasNativeReports
    ? 'not-available'
    : state?.reportsLive === undefined
      ? 'checking'
      : state.reportsLive
        ? 'live'
        : 'not-available';
  const reportSharing: CommunityFeatureState =
    reports !== 'live' ? reports : state?.canWrite === true ? 'live' : 'unsupported';

  const trafficFlow: CommunityFeatureState =
    serverLiveTraffic === undefined ? 'checking' : serverLiveTraffic ? 'live' : 'not-available';

  let trafficSharing: CommunityFeatureState;
  const sharing = state?.trafficSharing;
  if (!hasNativeTraffic) {
    trafficSharing = 'not-available';
  } else if (sharing === undefined) {
    trafficSharing = 'checking';
  } else if (sharing.state === 'unavailable' && sharing.reason === 'unsupported') {
    trafficSharing = 'unsupported';
  } else if (sharing.state === 'unavailable' && sharing.reason === 'not-accepting') {
    trafficSharing = 'not-available';
  } else if (TRAFFIC_STATE_ACCEPTED[sharing.state]) {
    // The server has already answered this trip: it accepts (or will accept) speeds.
    trafficSharing = 'live';
  } else if (serverLiveTraffic !== true) {
    // Nothing says the server accepts speeds. A switch that may never send must not look live.
    trafficSharing = serverLiveTraffic === undefined ? 'checking' : 'not-available';
  } else {
    trafficSharing = state?.canWrite === true ? 'live' : 'unsupported';
  }

  return { reportSharing, reports, trafficFlow, trafficSharing };
}

// --- Reports on the map ---------------------------------------------------------------------

export function communityReportLabel(type: NativeCommunityReportType): string {
  return ROAD_REPORT_TYPES.find((option) => option.id === type)?.label ?? 'Road report';
}

/** The report type's symbol, as on the report picker. */
export function communityReportSymbol(type: NativeCommunityReportType) {
  return (
    ROAD_REPORT_TYPES.find((option) => option.id === type)?.icon ?? {
      android: 'warning',
      ios: 'exclamationmark.triangle.fill',
    }
  );
}

/** Marker image name, registered with the map from `assets/images/report-*.png`. */
export function communityReportIcon(report: Pick<NativeCommunityReport, 'state' | 'type'>) {
  return report.state === 'confirmed'
    ? `report-${report.type}`
    : `report-${report.type}-unconfirmed`;
}

/** Horizontal spacing, in marker-image pixels, between reports published at the same spot. */
const STACKED_MARKER_SPACING = 64;

/**
 * Map features for the report layer. The server snaps positions to a ~55 m grid, so different
 * reports often share a point: those are spread side by side (`offset`) so each stays visible
 * and tappable instead of one hiding the other.
 */
export function communityReportFeatures(
  reports: readonly NativeCommunityReport[],
): FeatureCollection<
  Point,
  { confirmed: boolean; icon: string; id: string; offset: [number, number] }
> {
  const stacks: Record<string, string[]> = {};
  for (const report of reports) {
    const key = `${String(report.latitude)},${String(report.longitude)}`;
    (stacks[key] ??= []).push(report.id);
  }
  return {
    features: reports.map((report) => {
      const stack = stacks[`${String(report.latitude)},${String(report.longitude)}`] ?? [];
      const position = stack.indexOf(report.id) - (stack.length - 1) / 2;
      return {
        geometry: { coordinates: [report.longitude, report.latitude], type: 'Point' },
        properties: {
          confirmed: report.state === 'confirmed',
          icon: communityReportIcon(report),
          id: report.id,
          offset: [position * STACKED_MARKER_SPACING, 0],
        },
        type: 'Feature',
      };
    }),
    type: 'FeatureCollection',
  };
}

export interface GeographicBox {
  east: number;
  north: number;
  south: number;
  west: number;
}

function snapSpan(low: number, high: number): [number, number] {
  const grid = REPORT_FETCH_GRID_DEGREES;
  const maxCells = Math.round(REPORT_FETCH_MAX_SPAN_DEGREES / grid);
  let lowCell = Math.floor(low / grid + 1e-9);
  let highCell = Math.max(lowCell + 1, Math.ceil(high / grid - 1e-9));
  if (highCell - lowCell > maxCells) {
    // Wider than the service allows: keep the middle of the view.
    const centerCell = (low + high) / 2 / grid;
    lowCell = Math.round(centerCell - maxCells / 2);
    highCell = lowCell + maxCells;
  }
  return [Number((lowCell * grid).toFixed(2)), Number((highCell * grid).toFixed(2))];
}

/**
 * The visible area expanded outward to the 0.05° grid shared by report and flow requests, so
 * the map only reports a new area when the view crosses a grid line. Undefined when unusable.
 */
export function snapViewBox(
  bounds: readonly [west: number, south: number, east: number, north: number],
): GeographicBox | undefined {
  const [west, south, east, north] = bounds;
  if (![east, north, south, west].every(Number.isFinite) || east <= west || north <= south) {
    return undefined;
  }
  const grid = REPORT_FETCH_GRID_DEGREES;
  const snap = (value: number, round: (cells: number) => number, nudge: number) =>
    Number((round(value / grid + nudge) * grid).toFixed(2));
  return {
    east: Math.min(180, snap(east, Math.ceil, -1e-9)),
    north: Math.min(90, snap(north, Math.ceil, -1e-9)),
    south: Math.max(-90, snap(south, Math.floor, 1e-9)),
    west: Math.max(-180, snap(west, Math.floor, 1e-9)),
  };
}

/**
 * The box to ask for reports in: the visible area expanded outward to a 0.05° grid, and the
 * middle 0.5° of it when the view is wider. Undefined for an unusable viewport.
 */
export function reportFetchBounds(view: GeographicBox | undefined): GeographicBox | undefined {
  if (view === undefined) return undefined;
  const { east, north, south, west } = view;
  if (![east, north, south, west].every(Number.isFinite) || east <= west || north <= south) {
    return undefined;
  }
  const [snappedSouth, snappedNorth] = snapSpan(Math.max(-90, south), Math.min(90, north));
  const [snappedWest, snappedEast] = snapSpan(Math.max(-180, west), Math.min(180, east));
  return { east: snappedEast, north: snappedNorth, south: snappedSouth, west: snappedWest };
}

/** Coarse, honest age: the server rounds report times to five minutes. */
export function reportAgeLabel(reportedAtMs: number, nowMs: number): string {
  const minutes = (nowMs - reportedAtMs) / 60_000;
  if (minutes < 10) return 'Reported in the last few minutes';
  if (minutes < 55) return `Reported about ${String(Math.round(minutes / 5) * 5)} minutes ago`;
  if (minutes < 90) return 'Reported about an hour ago';
  return `Reported about ${String(Math.round(minutes / 60))} hours ago`;
}

export function reportConfirmationLabel(
  report: Pick<NativeCommunityReport, 'confirmations' | 'state'>,
): string {
  const { confirmations } = report;
  const count = confirmations === 1 ? '1 driver' : `${String(confirmations)} drivers`;
  if (report.state === 'confirmed') {
    return confirmations > 0 ? `Confirmed by ${count}` : 'Confirmed';
  }
  return confirmations > 0 ? `Unconfirmed · ${count} said it is still there` : 'Unconfirmed';
}

export type CommunityReportAction = 'not-present' | 'present' | 'withdraw';

export interface CommunityReportDetail {
  actions: readonly CommunityReportAction[];
  body: string;
  eyebrow: string;
  /** Why the actions are what they are; shown under them. */
  hint: string | undefined;
  title: string;
}

/** The detail sheet for a tapped report: what it is, how sure, how old, and what you can do. */
export function communityReportDetail(
  report: NativeCommunityReport,
  {
    answered,
    nowMs,
    reportSharing,
    sharesRoadReports,
  }: {
    /** This report was already answered from this phone in this session. */
    answered: boolean;
    nowMs: number;
    reportSharing: CommunityFeatureState;
    sharesRoadReports: boolean;
  },
): CommunityReportDetail {
  const body = [
    `${reportConfirmationLabel(report)}.`,
    `${reportAgeLabel(report.reportedAtMs, nowMs)}.`,
    '',
    'Shared by NavOSS drivers, not an official source. The position is approximate.',
  ].join('\n');
  const base = { body, eyebrow: 'Driver report', title: communityReportLabel(report.type) };

  if (report.isOwn) {
    return {
      ...base,
      actions: reportSharing === 'live' ? ['withdraw'] : [],
      hint: 'You shared this report. You can withdraw it until you close NavOSS.',
    };
  }
  if (answered) return { ...base, actions: [], hint: 'Thanks. Your answer was sent.' };
  if (reportSharing === 'unsupported') {
    return {
      ...base,
      actions: [],
      hint: 'Answering needs Apple App Attest, which this device does not provide.',
    };
  }
  if (reportSharing !== 'live') return { ...base, actions: [], hint: undefined };
  if (!sharesRoadReports) {
    return {
      ...base,
      actions: [],
      hint: 'To answer, turn on Share road reports in Map appearance › Community.',
    };
  }
  return {
    ...base,
    actions: ['present', 'not-present'],
    hint: 'Answering sends your current location once, only to check that you are within 1.5 km.',
  };
}

// --- Outcomes -------------------------------------------------------------------------------

export interface CommunityNotice {
  message: string;
  title: string;
  tone: 'danger' | 'info' | 'warning';
}

/**
 * The private-draft confirmation. It must stay true: the draft never leaves this iPhone, and
 * "yet" is said only where sharing does not exist on this server or device.
 */
export function privateDraftNotice(reportSharing: CommunityFeatureState): CommunityNotice {
  return {
    message:
      reportSharing === 'live'
        ? 'Saved privately on this iPhone for two hours and not shown to other drivers.'
        : 'Saved privately on this iPhone for two hours and not shown to other drivers yet.',
    title: 'Saved privately',
    tone: 'info',
  };
}

function retryLabel(seconds: number | undefined): string {
  if (seconds === undefined || !Number.isFinite(seconds) || seconds <= 0) return 'later';
  const minutes = Math.ceil(seconds / 60);
  if (minutes <= 1) return 'in a minute';
  if (minutes < 90) return `in about ${String(minutes)} minutes`;
  return `in about ${String(Math.round(minutes / 60))} hours`;
}

/** Why a report was not shared, in the driver's terms. */
function notSharedReason(error: NativeCommunityError, retryAfterSeconds?: number): string {
  switch (error) {
    case 'not-shared':
      return 'Share road reports is off, so nothing was sent.';
    case 'unsupported':
      return 'This device cannot share reports (it has no Apple App Attest), so nothing was sent.';
    case 'offline':
      return 'NavOSS could not be reached, so the report was not shared.';
    case 'rate-limited':
      return `You have shared several reports recently. You can share again ${retryLabel(retryAfterSeconds)}.`;
    case 'too-new':
      return `This iPhone was registered very recently. You can share ${retryLabel(retryAfterSeconds)}.`;
    case 'out-of-coverage':
      return 'Reports can be shared only inside NavOSS coverage.';
    case 'location-unavailable':
      return 'Your location is not available, so the report was not shared.';
    case 'too-far':
      return 'Your location is too far from this place to share a report about it.';
    case 'unavailable':
      return 'Report sharing is not available right now, so nothing was sent.';
    case 'identity-lost':
    case 'invalid-request':
    case 'rejected':
    case 'already-voted':
    case 'near-private-place':
    case 'not-found':
    case 'own-report':
      return 'NavOSS did not accept the report, so it was not shared.';
  }
}

export type ReportSubmitOutcome =
  | { kind: 'confirm-near-private-place' }
  | { kind: 'private'; notice: CommunityNotice }
  | { kind: 'shared'; notice: CommunityNotice };

/**
 * What to do with the bridge's answer to a submit. Anything other than a shared report or the
 * near-home question keeps the report as a private draft, exactly as before sharing existed.
 */
export function reportSubmitOutcome(
  result: NativeCommunityResult<{ merged: boolean }>,
): ReportSubmitOutcome {
  if (result.ok) {
    return {
      kind: 'shared',
      notice: result.merged
        ? {
            message:
              'A driver already reported this here, so yours was added to it. Drivers nearby see it at an approximate location.',
            title: 'Added to an existing report',
            tone: 'info',
          }
        : {
            message:
              'Drivers nearby see it at an approximate location. It expires on its own unless others confirm it.',
            title: 'Shared with other drivers',
            tone: 'info',
          },
    };
  }
  if (result.error === 'near-private-place') return { kind: 'confirm-near-private-place' };
  return {
    kind: 'private',
    notice: {
      message: `${notSharedReason(result.error, result.retryAfterSeconds)} Saved privately on this iPhone instead.`,
      title: 'Not shared',
      tone: result.error === 'not-shared' ? 'info' : 'warning',
    },
  };
}

export function voteNotice(
  vote: 'not-present' | 'present',
  result: NativeCommunityResult<{ active: boolean }>,
): CommunityNotice {
  if (result.ok) {
    return vote === 'present'
      ? {
          message: 'Other drivers keep seeing this report.',
          title: 'Thanks for confirming',
          tone: 'info',
        }
      : {
          message: result.active
            ? 'Your answer was counted. The report ends when enough drivers agree.'
            : 'The report was removed for other drivers.',
          title: 'Thanks for checking',
          tone: 'info',
        };
  }
  const message = (() => {
    switch (result.error) {
      case 'already-voted':
        return 'You already answered for this report.';
      case 'own-report':
        return 'You cannot answer for your own report.';
      case 'too-far':
        return 'Answers count only within 1.5 km of the report.';
      case 'not-found':
        return 'This report has already ended.';
      case 'location-unavailable':
        return 'Your location is not available yet.';
      case 'offline':
        return 'NavOSS could not be reached. Nothing was sent.';
      case 'rate-limited':
        return `Too many answers recently. Try again ${retryLabel(result.retryAfterSeconds)}.`;
      case 'unsupported':
        return 'This device cannot answer reports (it has no Apple App Attest).';
      case 'too-new':
        return `This iPhone was registered very recently. Try again ${retryLabel(result.retryAfterSeconds)}.`;
      default:
        return 'NavOSS did not accept the answer.';
    }
  })();
  return { message, title: 'Answer not sent', tone: 'warning' };
}

export function withdrawNotice(result: NativeCommunityResult): CommunityNotice {
  if (result.ok) {
    return { message: 'Other drivers no longer see it.', title: 'Report withdrawn', tone: 'info' };
  }
  return {
    message:
      result.error === 'offline'
        ? 'NavOSS could not be reached. The report is still shared.'
        : result.error === 'not-found'
          ? 'This report has already ended.'
          : 'NavOSS did not accept the request. The report is still shared.',
    title: 'Report not withdrawn',
    tone: 'warning',
  };
}

export function resetIdentityNotice(result: NativeCommunityResult): CommunityNotice {
  if (result.ok) {
    return {
      message:
        'Your shared reports and answers were deleted from NavOSS. A new, unrelated identity is created the next time you share.',
      title: 'Community identity reset',
      tone: 'info',
    };
  }
  if (result.error === 'identity-lost') {
    return {
      message:
        'This iPhone had lost its community key, so NavOSS could not delete it. Its reports expire on their own; the next share starts a new identity.',
      title: 'Identity could not be deleted',
      tone: 'warning',
    };
  }
  return {
    message:
      result.error === 'offline'
        ? 'NavOSS could not be reached. Nothing was deleted; try again when you are online.'
        : 'NavOSS did not accept the request. Nothing was deleted.',
    title: 'Identity not reset',
    tone: 'warning',
  };
}

/** What happens to the next report, stated before the driver picks one. */
export function reportSheetNotice(sharing: {
  availability: CommunityFeatureState;
  enabled: boolean;
}): string {
  const safety = 'Report only while stopped or as a passenger.';
  switch (sharing.availability) {
    case 'live':
      return sharing.enabled
        ? `Shared with other drivers at an approximate location. It expires on its own unless others confirm it. ${safety}`
        : `Sharing is off: reports are saved privately on this iPhone for two hours and not shown to other drivers. ${safety}`;
    case 'unsupported':
      return `Saved privately on this iPhone for two hours. This device cannot share reports with other drivers. ${safety}`;
    case 'checking':
    case 'not-available':
      return `Saved privately on this iPhone for two hours and not shown to other drivers yet. ${safety}`;
  }
}

// --- Answering and withdrawing ------------------------------------------------------------

/** The position a vote is checked against, with what the native side needs to re-validate it. */
export interface VoteObservation {
  horizontalAccuracyMeters: number;
  latitude: number;
  longitude: number;
  timestampMs: number;
}

/**
 * A vote may rest only on a fresh, accurate fix: the same rules as a route origin (at most
 * 15 s old, 100 m accuracy), which the native side applies again before sending anything.
 */
export function voteObservationFromSample(
  sample: RouteOriginSample | undefined,
  nowMs: number,
): VoteObservation | undefined {
  if (sample?.accuracyMeters === undefined) return undefined;
  if (routeRequestOriginFromSample(sample, nowMs) === undefined) return undefined;
  return {
    horizontalAccuracyMeters: sample.accuracyMeters,
    latitude: sample.coordinate.latitude,
    longitude: sample.coordinate.longitude,
    timestampMs: sample.capturedAtMs,
  };
}

export const LOCATION_NEEDED_NOTICE: CommunityNotice = {
  message: 'We need your current location to confirm this. Nothing was sent.',
  title: 'Answer not sent',
  tone: 'warning',
};

/**
 * Runs a report action from the detail sheet. A withdrawal needs no position. A vote first gets
 * a fresh fix; when location is denied, stale or inaccurate, nothing is requested.
 */
export async function runCommunityReportAction({
  action,
  getFreshSample,
  nowMs,
  reportId,
  vote,
  withdraw,
}: {
  action: CommunityReportAction;
  getFreshSample: () => Promise<RouteOriginSample | undefined>;
  nowMs: () => number;
  reportId: string;
  vote: (
    reportId: string,
    vote: 'not-present' | 'present',
    observedAt: VoteObservation,
  ) => Promise<CommunityNotice>;
  withdraw: (reportId: string) => Promise<CommunityNotice>;
}): Promise<CommunityNotice> {
  if (action === 'withdraw') return withdraw(reportId);
  const sample = await getFreshSample().catch(() => undefined);
  const observation = voteObservationFromSample(sample, nowMs());
  if (observation === undefined) return LOCATION_NEEDED_NOTICE;
  return vote(reportId, action, observation);
}

// --- Settings copy --------------------------------------------------------------------------

export interface CommunityRowStatus {
  /** The switch is real: turning it on can do what it says. */
  enabled: boolean;
  /** Short state under the row's title. */
  detail: string;
}

export function reportSharingRowStatus(availability: CommunityFeatureState): CommunityRowStatus {
  switch (availability) {
    case 'live':
      return {
        detail: 'Reports you choose are shown to other drivers at an approximate location',
        enabled: true,
      };
    case 'unsupported':
      return {
        detail: 'Not supported on this device. Reports stay private on this iPhone.',
        enabled: false,
      };
    case 'checking':
      return { detail: 'Checking…', enabled: false };
    case 'not-available':
      return {
        detail: 'Not available yet. Reports stay private on this iPhone.',
        enabled: false,
      };
  }
}

export function showReportsRowStatus(availability: CommunityFeatureState): CommunityRowStatus {
  return availability === 'live'
    ? { detail: 'Reports from other NavOSS drivers', enabled: true }
    : availability === 'checking'
      ? { detail: 'Checking…', enabled: false }
      : { detail: 'Not available yet', enabled: false };
}

export function showTrafficRowStatus(availability: CommunityFeatureState): CommunityRowStatus {
  return availability === 'live'
    ? { detail: 'Speeds from opted-in NavOSS drivers, where enough have driven', enabled: true }
    : availability === 'checking'
      ? { detail: 'Checking…', enabled: false }
      : { detail: 'Not available yet', enabled: false };
}

/** "Share traffic speeds": the switch's honest state, including "starts tomorrow". */
export function trafficSharingRowStatus(
  availability: CommunityFeatureState,
  sharing: NativeTrafficSharingState | undefined,
  enabled: boolean,
): CommunityRowStatus {
  if (availability === 'unsupported') {
    return { detail: 'Not supported on this device', enabled: false };
  }
  if (availability === 'not-available') return { detail: 'Not available yet', enabled: false };
  if (availability === 'checking') return { detail: 'Checking…', enabled: false };
  if (!enabled || sharing === undefined) {
    return { detail: 'Off. Nothing is sent.', enabled: true };
  }
  switch (sharing.state) {
    case 'starts-later':
      return { detail: 'Traffic sharing starts tomorrow', enabled: true };
    case 'paused':
      return { detail: 'Paused for a few minutes by NavOSS', enabled: true };
    case 'sharing':
      return { detail: 'Sharing during this trip', enabled: true };
    case 'starting':
      return { detail: 'Starting…', enabled: true };
    case 'unavailable':
      return {
        detail:
          sharing.reason === 'offline'
            ? 'Not sharing on this trip: no connection'
            : 'Not sharing on this trip',
        enabled: true,
      };
    case 'off':
    case 'ready':
      return { detail: 'On. Shares only during turn-by-turn navigation.', enabled: true };
  }
}

// --- Guidance -------------------------------------------------------------------------------

/** The report-ahead banner: only away from a maneuver, so it never competes with a turn. */
export function showsReportAhead(distanceToManeuverMeters: number | undefined): boolean {
  return (
    distanceToManeuverMeters === undefined ||
    distanceToManeuverMeters >= REPORT_AHEAD_MANEUVER_CLEARANCE_METERS
  );
}

/**
 * "Still there?" is asked only when the driver has agreed to share answers, the device can
 * sign them, no other decision is on screen and no maneuver is near.
 */
export function showsStillThere({
  competingPrompt,
  distanceToManeuverMeters,
  reportSharing,
  sharesRoadReports,
}: {
  competingPrompt: boolean;
  distanceToManeuverMeters: number | undefined;
  reportSharing: CommunityFeatureState;
  sharesRoadReports: boolean;
}): boolean {
  return (
    reportSharing === 'live' &&
    sharesRoadReports &&
    !competingPrompt &&
    (distanceToManeuverMeters === undefined ||
      distanceToManeuverMeters >= STILL_THERE_MANEUVER_CLEARANCE_METERS)
  );
}
