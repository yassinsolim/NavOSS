import type { Coordinate } from '@navoss/contracts';
import { startTransition, useEffect, useMemo, useRef, useState } from 'react';

import {
  type CommunityAvailability,
  communityAvailability,
  type CommunityNotice,
  type GeographicBox,
  reportSubmitOutcome,
  type ReportSubmitOutcome,
  resetIdentityNotice,
  voteNotice,
  withdrawNotice,
} from '@/features/community/community';
import type { RoadReportType } from '@/features/map/road-report-drafts';
import {
  dismissStillThere,
  fetchCommunityReports,
  getCommunityState,
  hasNativeCommunity,
  hasNativeCommunityTraffic,
  type NativeCommunityReport,
  type NativeCommunityState,
  observeCommunityState,
  resetCommunityIdentity,
  setShareRoadReports,
  setShareTrafficSpeeds,
  submitCommunityReport,
  voteCommunityReport,
  withdrawCommunityReport,
} from '@/features/navigation/native-navigation';

const NO_REPORTS: readonly NativeCommunityReport[] = [];
/** Wait for the map to settle before asking for a new area. */
const FETCH_DEBOUNCE_MS = 600;
/**
 * Ask again for the same area this often. Native answers from its cache while that is fresh
 * (120 s) and keeps a 20 s floor between requests, so this only bounds how late a refused or
 * stale area is retried.
 */
const REFRESH_MS = 30_000;
/** Expired reports leave the map even when nothing else changes. */
const EXPIRY_TICK_MS = 60_000;

export interface Community {
  /** Ids answered from this phone in this app session. */
  answeredIds: ReadonlySet<string>;
  availability: CommunityAvailability;
  dismissStillThere: (reportId: string) => void;
  /** Active reports to draw: empty unless reports are live and shown. */
  reports: readonly NativeCommunityReport[];
  resetIdentity: () => Promise<CommunityNotice>;
  setShareRoadReports: (enabled: boolean) => void;
  setShareTrafficSpeeds: (enabled: boolean) => void;
  state: NativeCommunityState | undefined;
  submit: (
    type: RoadReportType,
    coordinate: Coordinate,
    options: { confirmNearPrivatePlace: boolean; heading: number | undefined },
  ) => Promise<ReportSubmitOutcome>;
  /** `observedAt`: the phone's own fresh fix, for a vote outside guidance. */
  vote: (
    reportId: string,
    vote: 'not-present' | 'present',
    observedAt?: Coordinate,
  ) => Promise<CommunityNotice>;
  withdraw: (reportId: string) => Promise<CommunityNotice>;
}

/**
 * The phone's view of the native community service (shared with CarPlay). It mirrors the native
 * state, asks for reports in the visible area while reports are live and shown, and wraps every
 * write so its outcome comes back as copy the driver can read. Against a server without community
 * features nothing here makes a request: the bridge reads `/v2/config` itself (at most every ten
 * minutes) and answers `reportsLive: false`.
 */
export function useCommunity({
  appActive,
  fetchBounds,
  serverLiveTraffic,
  showReports,
}: {
  appActive: boolean;
  /** Snapped area to keep fetched (see `reportFetchBounds`); undefined while unknown. */
  fetchBounds: GeographicBox | undefined;
  serverLiveTraffic: boolean | undefined;
  showReports: boolean;
}): Community {
  const [hasNativeReports] = useState(() => hasNativeCommunity());
  const [hasNativeTraffic] = useState(() => hasNativeCommunityTraffic());
  const [state, setState] = useState<NativeCommunityState>();
  const [answeredIds, setAnsweredIds] = useState<ReadonlySet<string>>(() => new Set());
  const [nowMs, setNowMs] = useState(() => Date.now());
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    if (!hasNativeReports || !appActive) return;
    let cancelled = false;
    void getCommunityState()
      .then((next) => {
        if (!cancelled) setState(next);
      })
      .catch(() => undefined);
    const subscription = observeCommunityState((next) => {
      startTransition(() => {
        setState(next);
      });
    });
    return () => {
      cancelled = true;
      subscription.remove();
    };
  }, [appActive, hasNativeReports]);

  const availability = useMemo(
    () => communityAvailability({ hasNativeReports, hasNativeTraffic, serverLiveTraffic, state }),
    [hasNativeReports, hasNativeTraffic, serverLiveTraffic, state],
  );
  const reportsLive = availability.reports === 'live';

  const west = fetchBounds?.west;
  const south = fetchBounds?.south;
  const east = fetchBounds?.east;
  const north = fetchBounds?.north;
  useEffect(() => {
    if (
      !reportsLive ||
      !showReports ||
      !appActive ||
      west === undefined ||
      south === undefined ||
      east === undefined ||
      north === undefined
    ) {
      return;
    }
    // Native caches by area (fresh for 120 s), keeps a 20 s floor between requests and publishes
    // what it fetched through `onCommunityStateChanged`, so the answer itself is not needed here.
    const fetchArea = () => {
      void fetchCommunityReports({ east, north, south, west }).catch(() => undefined);
    };
    const timeout = setTimeout(fetchArea, FETCH_DEBOUNCE_MS);
    const interval = setInterval(fetchArea, REFRESH_MS);
    return () => {
      clearTimeout(timeout);
      clearInterval(interval);
    };
  }, [appActive, east, north, reportsLive, showReports, south, west]);

  const allReports = state?.reports ?? NO_REPORTS;
  const hasReports = allReports.length > 0;
  useEffect(() => {
    if (!hasReports) return;
    const interval = setInterval(() => {
      setNowMs(Date.now());
    }, EXPIRY_TICK_MS);
    return () => {
      clearInterval(interval);
    };
  }, [hasReports]);

  const reports = useMemo(
    () =>
      reportsLive && showReports
        ? allReports.filter((report) => report.expiresAtMs > nowMs)
        : NO_REPORTS,
    [allReports, nowMs, reportsLive, showReports],
  );

  const refresh = () => {
    void getCommunityState()
      .then((next) => {
        if (mountedRef.current) setState(next);
      })
      .catch(() => undefined);
  };

  return {
    answeredIds,
    availability,
    dismissStillThere: (reportId) => {
      dismissStillThere(reportId);
    },
    reports,
    resetIdentity: async () => {
      const result = await resetCommunityIdentity().catch(() => ({
        error: 'unavailable' as const,
        ok: false as const,
      }));
      if (result.ok) setAnsweredIds(new Set());
      refresh();
      return resetIdentityNotice(result);
    },
    setShareRoadReports: (enabled) => {
      setShareRoadReports(enabled);
      refresh();
    },
    setShareTrafficSpeeds: (enabled) => {
      setShareTrafficSpeeds(enabled);
      refresh();
    },
    state,
    submit: async (type, coordinate, { confirmNearPrivatePlace, heading }) => {
      const result = await submitCommunityReport({
        latitude: coordinate.latitude,
        longitude: coordinate.longitude,
        type,
        ...(confirmNearPrivatePlace ? { confirmNearPrivatePlace } : {}),
        ...(heading === undefined || !Number.isFinite(heading)
          ? {}
          : { heading: Math.round(((heading % 360) + 360) % 360) % 360 }),
      }).catch(() => ({ error: 'unavailable' as const, ok: false as const }));
      return reportSubmitOutcome(result);
    },
    vote: async (reportId, vote, observedAt) => {
      const result = await voteCommunityReport(reportId, vote, observedAt).catch(() => ({
        error: 'unavailable' as const,
        ok: false as const,
      }));
      if (result.ok || result.error === 'already-voted') {
        setAnsweredIds((current) => new Set(current).add(reportId));
      }
      return voteNotice(vote, result);
    },
    withdraw: async (reportId) => {
      const result = await withdrawCommunityReport(reportId).catch(() => ({
        error: 'unavailable' as const,
        ok: false as const,
      }));
      return withdrawNotice(result);
    },
  };
}
