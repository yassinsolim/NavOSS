import { setTimeout as delay } from 'node:timers/promises';

import {
  createServiceCoverage,
  type GeographicBounds,
  type ServiceArea,
  type ServiceCoverage,
} from '@navoss/contracts';

import type { CoverageReadiness } from './coverage-readiness.js';

/**
 * What the server publishes out of what it declares (`NAVOSS_SERVICE_AREAS`): only provinces whose
 * routing graph and search index have answered for them at least once.
 *
 * - A province is added the first time its data answers and never removed. The installed data does
 *   not change while the API runs (a new release recreates the API), and phones cache `/v2/config`
 *   for a launch (and the native client for an hour), so coverage must not flap with a slow
 *   dependency. A dependency that fails later fails its own requests (503) and `/ready`.
 * - Until any province has answered nothing is published: `/v2/config`, search and routes answer
 *   503, and each such request first checks again, so the API serves as soon as the data answers,
 *   not at the next background check.
 * - A partial publication keeps checking the rest in the background (and on requests, throttled)
 *   and adds each province as its data answers. `/ready` and `check-coverage.sh` keep failing until
 *   every declared province is published, so a partial cutover is visible and rolled back.
 */
export interface CoveragePublication {
  /** The published coverage, or `undefined` while no declared province has answered. */
  current(): ServiceCoverage | undefined;
  /** Declared provinces not published yet, in registry order. */
  pending(): readonly ServiceArea[];
  /** Checks the pending provinces again unless a check ran within the throttle; never removes. */
  refresh(): Promise<ServiceCoverage | undefined>;
  /** For `/ready`: checks every declared province now; records those that answer. */
  missingNow(): Promise<readonly ServiceArea[]>;
  /** Retries for the startup window, then keeps checking in the background until complete. */
  start(): Promise<void>;
  close(): void;
}

export interface CoveragePublicationOptions {
  /** How long `start()` keeps retrying before the API serves what has answered (default 20 s). */
  startupMs?: number;
  /** Pause between startup attempts (default 2 s). */
  retryMs?: number;
  /** Background check interval while a declared province is pending (default 30 s). */
  intervalMs?: number;
  /** Request-triggered checks run at most this often (default 5 s). */
  minRefreshMs?: number;
  now?: () => number;
  /** Told the published and pending registry ids whenever publication changes; no request data. */
  onChange?: (published: readonly string[], pending: readonly string[]) => void;
}

/** A coverage that publishes everything it declares: no data check is configured. */
export function createStaticCoveragePublication(declared: ServiceCoverage): CoveragePublication {
  return {
    close: () => undefined,
    current: () => declared,
    missingNow: () => Promise.resolve([]),
    pending: () => [],
    refresh: () => Promise.resolve(declared),
    start: () => Promise.resolve(),
  };
}

export function createCoveragePublication(
  declared: ServiceCoverage,
  readiness: CoverageReadiness,
  options: CoveragePublicationOptions = {},
): CoveragePublication {
  const now = options.now ?? Date.now;
  const minRefreshMs = options.minRefreshMs ?? 5_000;
  const verified = new Set<string>();
  let published: ServiceCoverage | undefined;
  let inFlight: Promise<ServiceCoverage | undefined> | undefined;
  let lastCheck = Number.NEGATIVE_INFINITY;
  let timer: NodeJS.Timeout | undefined;
  let closed = false;

  const pending = () => declared.areas.filter(({ id }) => !verified.has(id));

  function record(missing: readonly ServiceArea[]) {
    const missingIds = new Set(missing.map(({ id }) => id));
    const before = verified.size;
    for (const { id } of declared.areas) if (!missingIds.has(id)) verified.add(id);
    if (verified.size === before) return;
    published = createServiceCoverage(
      declared.areas.filter(({ id }) => verified.has(id)).map(({ id }) => id),
    );
    options.onChange?.(
      published.areas.map(({ id }) => id),
      pending().map(({ id }) => id),
    );
    if (pending().length === 0 && timer !== undefined) {
      clearInterval(timer);
      timer = undefined;
    }
  }

  async function check(): Promise<ServiceCoverage | undefined> {
    lastCheck = now();
    try {
      record(await readiness.missingAreas());
    } catch {
      // A failed check publishes nothing new; the next one tries again.
    }
    return published;
  }

  function refresh(force = false): Promise<ServiceCoverage | undefined> {
    if (pending().length === 0) return Promise.resolve(published);
    if (inFlight !== undefined) return inFlight;
    if (!force && now() - lastCheck < minRefreshMs) return Promise.resolve(published);
    inFlight = check().finally(() => {
      inFlight = undefined;
    });
    return inFlight;
  }

  return {
    close() {
      closed = true;
      clearInterval(timer);
      timer = undefined;
    },
    current: () => published,
    async missingNow() {
      const missing = await readiness.missingAreas();
      record(missing);
      return missing;
    },
    pending,
    refresh: () => refresh(),
    async start() {
      const deadline = now() + (options.startupMs ?? 20_000);
      await refresh(true);
      while (!closed && pending().length > 0 && now() < deadline) {
        await delay(options.retryMs ?? 2_000);
        await refresh(true);
      }
      if (!closed && pending().length > 0) {
        timer = setInterval(() => void refresh(true), options.intervalMs ?? 30_000);
        timer.unref();
      }
    },
  };
}

// Contains nothing: south of north and east of west are both impossible.
const NO_BOUNDS: GeographicBounds = {
  northEast: { latitude: -90, longitude: -180 },
  southWest: { latitude: 90, longitude: 180 },
};

/**
 * A `ServiceCoverage` that always answers for what is published now, for consumers built once at
 * startup (search providers, community reports). Before anything is published it contains nothing.
 */
export function publishedCoverageView(publication: CoveragePublication): ServiceCoverage {
  return {
    areaForCoordinate: (coordinate) => publication.current()?.areaForCoordinate(coordinate),
    get areas() {
      return publication.current()?.areas ?? [];
    },
    get bounds() {
      return publication.current()?.bounds ?? NO_BOUNDS;
    },
    contains: (coordinate) => publication.current()?.contains(coordinate) ?? false,
    disconnectedAreas: (coordinates) => publication.current()?.disconnectedAreas(coordinates),
    get displayName() {
      return publication.current()?.displayName ?? '';
    },
    get id() {
      return publication.current()?.id ?? '';
    },
  };
}
