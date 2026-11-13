import { describe, expect, it, vi } from 'vitest';

import type { CommunityNotice } from '../src/features/community/community.js';
import type { RouteOriginSample } from '../src/features/navigation/route-origin.js';

vi.mock('@react-native-async-storage/async-storage', () => ({
  default: { getItem: vi.fn(), setItem: vi.fn() },
}));

import {
  communityAvailability,
  communityReportDetail,
  communityReportFeatures,
  privateDraftNotice,
  reportAgeLabel,
  reportConfirmationLabel,
  reportFetchBounds,
  reportSheetNotice,
  reportSubmitOutcome,
  resetIdentityNotice,
  runCommunityReportAction,
  showsReportAhead,
  showsStillThere,
  snapViewBox,
  trafficSharingRowStatus,
  voteNotice,
} from '../src/features/community/community.js';
import type {
  NativeCommunityReport,
  NativeCommunityState,
} from '../src/features/navigation/native-navigation.js';

const MINUTE = 60_000;
const NOW = Date.UTC(2026, 10, 12, 18, 0);

function state(overrides: Partial<NativeCommunityState> = {}): NativeCommunityState {
  return {
    canWrite: true,
    hasIdentity: false,
    preferences: {
      announcesRoadReports: false,
      sharesRoadReports: false,
      sharesTrafficSpeeds: false,
    },
    reports: [],
    reportsLive: true,
    trafficSharing: { state: 'off' },
    ...overrides,
  };
}

function report(overrides: Partial<NativeCommunityReport> = {}): NativeCommunityReport {
  return {
    confirmations: 0,
    expiresAtMs: NOW + 120 * MINUTE,
    id: 'r1',
    isOwn: false,
    latitude: 51.0447,
    longitude: -114.0719,
    reportedAtMs: NOW - 15 * MINUTE,
    state: 'unconfirmed',
    type: 'collision',
    ...overrides,
  };
}

describe('community availability', () => {
  it('offers nothing against a server without community features (the deployed API)', () => {
    const availability = communityAvailability({
      hasNativeReports: true,
      hasNativeTraffic: true,
      serverLiveTraffic: false,
      state: state({ reportsLive: false }),
    });
    expect(availability).toEqual({
      reportSharing: 'not-available',
      reports: 'not-available',
      trafficFlow: 'not-available',
      trafficSharing: 'not-available',
    });
  });

  it('does not let a turned-on traffic switch look live when the server never said it accepts', () => {
    // Sharing on (native says ready) but the server declares no live traffic: the switch must
    // read "Not available yet", not "On".
    const availability = communityAvailability({
      hasNativeReports: true,
      hasNativeTraffic: true,
      serverLiveTraffic: false,
      state: state({
        preferences: {
          announcesRoadReports: false,
          sharesRoadReports: false,
          sharesTrafficSpeeds: true,
        },
        trafficSharing: { state: 'ready' },
      }),
    });
    expect(availability.trafficSharing).toBe('not-available');
    expect(trafficSharingRowStatus(availability.trafficSharing, { state: 'ready' }, true)).toEqual({
      detail: 'Not available yet',
      enabled: false,
    });
  });

  it('treats a server that answered the trip as accepting, and 404 as not available', () => {
    const accepted = communityAvailability({
      hasNativeReports: true,
      hasNativeTraffic: true,
      serverLiveTraffic: false,
      state: state({ trafficSharing: { state: 'starts-later', untilMs: NOW + 24 * 60 * MINUTE } }),
    });
    expect(accepted.trafficSharing).toBe('live');
    const refused = communityAvailability({
      hasNativeReports: true,
      hasNativeTraffic: true,
      serverLiveTraffic: true,
      state: state({ trafficSharing: { reason: 'not-accepting', state: 'unavailable' } }),
    });
    expect(refused.trafficSharing).toBe('not-available');
  });

  it('separates a device that cannot sign from a server that is not live', () => {
    const availability = communityAvailability({
      hasNativeReports: true,
      hasNativeTraffic: true,
      serverLiveTraffic: true,
      state: state({ canWrite: false }),
    });
    expect(availability.reports).toBe('live');
    expect(availability.reportSharing).toBe('unsupported');
    expect(availability.trafficSharing).toBe('unsupported');
  });

  it('waits for the bridge instead of guessing, and an old native build has nothing', () => {
    expect(
      communityAvailability({
        hasNativeReports: true,
        hasNativeTraffic: true,
        serverLiveTraffic: undefined,
        state: undefined,
      }),
    ).toMatchObject({ reportSharing: 'checking', reports: 'checking', trafficFlow: 'checking' });
    expect(
      communityAvailability({
        hasNativeReports: false,
        hasNativeTraffic: false,
        serverLiveTraffic: true,
        state: undefined,
      }),
    ).toMatchObject({ reportSharing: 'not-available', reports: 'not-available' });
  });
});

describe('traffic sharing status', () => {
  it('says "starts tomorrow" for a new installation, and is honest about a paused trip', () => {
    expect(
      trafficSharingRowStatus('live', { state: 'starts-later', untilMs: NOW + MINUTE }, true)
        .detail,
    ).toBe('Traffic sharing starts tomorrow');
    expect(trafficSharingRowStatus('live', { state: 'paused', untilMs: NOW }, true).detail).toBe(
      'Paused for a few minutes by NavOSS',
    );
    expect(trafficSharingRowStatus('live', { state: 'off' }, false)).toEqual({
      detail: 'Off. Nothing is sent.',
      enabled: true,
    });
  });
});

describe('report copy', () => {
  it('states the private path truthfully in every sharing state', () => {
    expect(reportSheetNotice({ availability: 'not-available', enabled: false })).toContain(
      'Saved privately on this iPhone',
    );
    expect(reportSheetNotice({ availability: 'not-available', enabled: true })).toContain(
      'not shown to other drivers yet',
    );
    expect(reportSheetNotice({ availability: 'live', enabled: false })).toContain(
      'saved privately on this iPhone',
    );
    expect(reportSheetNotice({ availability: 'live', enabled: true })).toContain(
      'Shared with other drivers',
    );
    expect(privateDraftNotice('not-available').message).toBe(
      'Saved privately on this iPhone for two hours and not shown to other drivers yet.',
    );
  });

  it('keeps every refused submit as a private draft, and asks again near a private place', () => {
    expect(reportSubmitOutcome({ error: 'near-private-place', ok: false })).toEqual({
      kind: 'confirm-near-private-place',
    });
    for (const error of [
      'unavailable',
      'unsupported',
      'rate-limited',
      'too-far',
      'offline',
      'not-shared',
      'out-of-coverage',
      'rejected',
    ] as const) {
      const outcome = reportSubmitOutcome({ error, ok: false });
      expect(outcome.kind).toBe('private');
      if (outcome.kind === 'private') {
        expect(outcome.notice.message).toContain('Saved privately on this iPhone instead.');
      }
    }
    const limited = reportSubmitOutcome({
      error: 'rate-limited',
      ok: false,
      retryAfterSeconds: 600,
    });
    expect(limited.kind === 'private' && limited.notice.message).toContain('in about 10 minutes');
    expect(reportSubmitOutcome({ merged: true, ok: true })).toMatchObject({
      kind: 'shared',
      notice: { title: 'Added to an existing report' },
    });
  });

  it('describes vote and reset failures without claiming anything was sent', () => {
    expect(voteNotice('present', { error: 'too-far', ok: false })).toEqual({
      message: 'Answers count only within 1.5 km of the report.',
      title: 'Answer not sent',
      tone: 'warning',
    });
    expect(voteNotice('not-present', { active: false, ok: true }).message).toBe(
      'The report was removed for other drivers.',
    );
    expect(resetIdentityNotice({ error: 'offline', ok: false }).message).toContain(
      'Nothing was deleted',
    );
  });
});

describe('report detail', () => {
  const options = {
    answered: false,
    nowMs: NOW,
    reportSharing: 'live' as const,
    sharesRoadReports: true,
  };

  it('offers Still there / Not there only to a sharing driver who has not answered', () => {
    expect(communityReportDetail(report(), options).actions).toEqual(['present', 'not-present']);
    expect(communityReportDetail(report(), { ...options, answered: true }).actions).toEqual([]);
    const notSharing = communityReportDetail(report(), { ...options, sharesRoadReports: false });
    expect(notSharing.actions).toEqual([]);
    expect(notSharing.hint).toContain('Share road reports');
    expect(
      communityReportDetail(report(), { ...options, reportSharing: 'unsupported' }).actions,
    ).toEqual([]);
  });

  it('lets the driver withdraw only their own report, never vote on it', () => {
    expect(communityReportDetail(report({ isOwn: true }), options).actions).toEqual(['withdraw']);
  });

  it('says what the report is, how sure and how old, and that it is not official', () => {
    const detail = communityReportDetail(
      report({ confirmations: 2, state: 'confirmed', type: 'road-closure' }),
      options,
    );
    expect(detail.title).toBe('Road closed');
    expect(detail.body).toContain('Confirmed by 2 drivers.');
    expect(detail.body).toContain('Reported about 15 minutes ago.');
    expect(detail.body).toContain('not an official source');
  });

  it('labels age coarsely (server times are rounded to five minutes)', () => {
    expect(reportAgeLabel(NOW - 4 * MINUTE, NOW)).toBe('Reported in the last few minutes');
    expect(reportAgeLabel(NOW - 23 * MINUTE, NOW)).toBe('Reported about 25 minutes ago');
    expect(reportAgeLabel(NOW - 70 * MINUTE, NOW)).toBe('Reported about an hour ago');
    expect(reportAgeLabel(NOW - 185 * MINUTE, NOW)).toBe('Reported about 3 hours ago');
    expect(reportConfirmationLabel({ confirmations: 0, state: 'unconfirmed' })).toBe('Unconfirmed');
  });
});

describe('report markers', () => {
  it('uses the faded marker until a report is confirmed', () => {
    const features = communityReportFeatures([
      report({ id: 'a' }),
      report({ id: 'b', state: 'confirmed', type: 'pothole' }),
    ]);
    expect(features.features.map((feature) => feature.properties.icon)).toEqual([
      'report-collision-unconfirmed',
      'report-pothole',
    ]);
    expect(features.features[0]?.geometry.coordinates).toEqual([-114.0719, 51.0447]);
  });

  it('spreads reports published at the same snapped point so none hides another', () => {
    const features = communityReportFeatures([
      report({ id: 'a' }),
      report({ id: 'b', type: 'pothole' }),
      report({ id: 'c', latitude: 51.05 }),
    ]);
    expect(features.features.map((feature) => feature.properties.offset)).toEqual([
      [-32, 0],
      [32, 0],
      [0, 0],
    ]);
  });
});

describe('report fetch area', () => {
  it('snaps the view outward to the 0.05° grid, so small pans keep the same box', () => {
    const a = snapViewBox([-114.112, 51.013, -114.031, 51.077]);
    const b = snapViewBox([-114.108, 51.011, -114.034, 51.071]);
    expect(a).toEqual({ east: -114, north: 51.1, south: 51, west: -114.15 });
    expect(b).toEqual(a);
  });

  it('never asks for more than 0.5° per side: a wide view keeps its middle', () => {
    const bounds = reportFetchBounds({ east: -113, north: 52, south: 50.5, west: -115 });
    expect(bounds).toBeDefined();
    if (bounds === undefined) return;
    expect(bounds.east - bounds.west).toBeCloseTo(0.5, 6);
    expect(bounds.north - bounds.south).toBeCloseTo(0.5, 6);
    expect((bounds.east + bounds.west) / 2).toBeCloseTo(-114, 6);
    expect((bounds.north + bounds.south) / 2).toBeCloseTo(51.25, 6);
    expect(reportFetchBounds({ east: -114, north: 51, south: 51.1, west: -114.1 })).toBeUndefined();
  });
});

describe('guidance prompts', () => {
  it('keeps both prompts away from an imminent maneuver', () => {
    expect(showsReportAhead(120)).toBe(false);
    expect(showsReportAhead(900)).toBe(true);
    const base = {
      competingPrompt: false,
      reportSharing: 'live' as const,
      sharesRoadReports: true,
    };
    expect(showsStillThere({ ...base, distanceToManeuverMeters: 450 })).toBe(false);
    expect(showsStillThere({ ...base, distanceToManeuverMeters: 1_200 })).toBe(true);
  });

  it('never asks a driver who has not agreed to share, or over another decision', () => {
    const base = { distanceToManeuverMeters: 2_000, reportSharing: 'live' as const };
    expect(showsStillThere({ ...base, competingPrompt: false, sharesRoadReports: false })).toBe(
      false,
    );
    expect(showsStillThere({ ...base, competingPrompt: true, sharesRoadReports: true })).toBe(
      false,
    );
  });
});

describe('answering a report needs a fresh, accurate fix', () => {
  const fresh: RouteOriginSample = {
    accuracyMeters: 12,
    capturedAtMs: NOW - 2_000,
    coordinate: { latitude: 51.0447, longitude: -114.0719 },
  };
  const thanks = { message: 'ok', title: 'Thanks', tone: 'info' as const };

  async function answer(
    getFreshSample: () => Promise<RouteOriginSample | undefined>,
  ): Promise<{ notice: CommunityNotice; vote: ReturnType<typeof vi.fn> }> {
    const vote = vi.fn(async () => thanks);
    const withdraw = vi.fn(async () => thanks);
    const notice = await runCommunityReportAction({
      action: 'present',
      getFreshSample,
      nowMs: () => NOW,
      reportId: 'r1',
      vote,
      withdraw,
    });
    expect(withdraw).not.toHaveBeenCalled();
    return { notice, vote };
  }

  it('sends the vote with the fix the native side re-validates', async () => {
    const { notice, vote } = await answer(async () => fresh);
    expect(notice).toBe(thanks);
    expect(vote).toHaveBeenCalledWith('r1', 'present', {
      horizontalAccuracyMeters: 12,
      latitude: 51.0447,
      longitude: -114.0719,
      timestampMs: NOW - 2_000,
    });
  });

  const refused: [string, () => Promise<RouteOriginSample | undefined>][] = [
    ['a stale fix', async () => ({ ...fresh, capturedAtMs: NOW - 60_000 })],
    ['a coarse fix', async () => ({ ...fresh, accuracyMeters: 650 })],
    ['a fix without accuracy', async () => ({ ...fresh, accuracyMeters: undefined })],
    [
      'denied location',
      async () => {
        throw new Error('denied');
      },
    ],
    ['no fix', async () => undefined],
  ];
  it.each(refused)('requests nothing with %s', async (_label, getFreshSample) => {
    const { notice, vote } = await answer(getFreshSample);
    expect(vote).not.toHaveBeenCalled();
    expect(notice.message).toBe('We need your current location to confirm this. Nothing was sent.');
  });

  it('withdraws an own report without asking for location', async () => {
    const getFreshSample = vi.fn(async () => undefined);
    const withdraw = vi.fn(async () => thanks);
    await runCommunityReportAction({
      action: 'withdraw',
      getFreshSample,
      nowMs: () => NOW,
      reportId: 'r1',
      vote: vi.fn(),
      withdraw,
    });
    expect(withdraw).toHaveBeenCalledWith('r1');
    expect(getFreshSample).not.toHaveBeenCalled();
  });
});
