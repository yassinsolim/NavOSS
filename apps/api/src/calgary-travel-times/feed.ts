import { z } from 'zod/v4';

import { calgaryLocalDateTime } from '../calgary-road-event-provider.js';

export const TRAVEL_TIMES_DATASET_ID = 'aeb8-fh2w';
export const TRAVEL_TIMES_URL = `https://data.calgary.ca/resource/${TRAVEL_TIMES_DATASET_ID}.json?$limit=200`;
const REQUEST_TIMEOUT_MS = 10_000;
// The feed publishes about every 20 minutes. One request every three minutes, conditional on the
// previous answer, sees a new value within three minutes and costs the City almost nothing.
export const TRAVEL_TIMES_POLL_MS = 3 * 60_000;
export const TRAVEL_TIMES_MIN_POLL_MS = 2 * 60_000;
// Above this share of malformed rows the answer is not trusted at all (PR #93: the City changed
// another dataset's schema without notice).
const MAX_MALFORMED_SHARE = 0.1;
const MAX_MINUTES = 240;
// A clock a few minutes apart from the City's is tolerated; a value further in the future is not.
const MAX_FUTURE_MS = 5 * 60_000;

/** One row as the City publishes it. Extra fields are tolerated and ignored. */
const RowSchema = z.object({
  last_update: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?$/u),
  road_segment: z.string().min(1).max(200),
  travel_time_mins: z.union([
    z.string().regex(/^\d{1,3}(\.0+)?$/u),
    z.number().int().nonnegative(),
  ]),
});
const RowsSchema = z.array(z.unknown()).max(1_000);

export interface TravelTimeRow {
  /** UTC milliseconds of the row's `last_update`, which the City gives in Calgary wall time. */
  lastUpdateMs: number;
  /** Whole minutes, as published. */
  minutes: number;
}

export interface TravelTimeSnapshot {
  fetchedAtMs: number;
  /** Keyed by the exact `road_segment` label. */
  rows: ReadonlyMap<string, TravelTimeRow>;
}

export interface TravelTimesFeedCounters {
  fetchFailures: number;
  fetches: number;
  malformedRows: number;
  notModified: number;
  rejectedAnswers: number;
}

export interface TravelTimesFeed {
  counters(): TravelTimesFeedCounters;
  /** The last accepted answer, however old; callers decide what is fresh enough. */
  snapshot(): TravelTimeSnapshot | undefined;
  /** Fetches once now (conditional on the previous answer). Never rejects. */
  refresh(): Promise<void>;
  start(): void;
  stop(): void;
}

export interface TravelTimesFeedOptions {
  clock?: () => number;
  fetchImplementation?: typeof fetch;
  onFailure?: (failure: { errorName: string; malformedRows?: number }) => void;
  pollMs?: number;
  url?: string;
}

export class TravelTimesFeedError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'TravelTimesFeedError';
  }
}

/**
 * Converts a Calgary wall-clock time without zone (`2026-11-26T23:03:43.000`) to UTC. The offset
 * is the one America/Edmonton had at that instant, found by checking both candidate offsets with
 * the same formatter the road-event provider uses. A time repeated when clocks fall back takes
 * the earlier instant (the older reading, so staleness errs towards discarding); a time skipped
 * when clocks spring forward does not exist and returns undefined.
 */
export function calgaryWallTimeToUtcMs(wall: string): number | undefined {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?$/u.exec(wall);
  if (match === null) return undefined;
  const [, year, month, day, hour, minute, second, fraction] = match;
  const asUtc = Date.UTC(
    Number(year),
    Number(month) - 1,
    Number(day),
    Number(hour),
    Number(minute),
    Number(second),
    Number((fraction ?? '0').padEnd(3, '0')),
  );
  const local = `${year ?? ''}-${month ?? ''}-${day ?? ''}T${hour ?? ''}:${minute ?? ''}:${second ?? ''}`;
  // Mountain Daylight Time (UTC-6) first: it is the earlier instant of a repeated hour.
  for (const offsetHours of [6, 7]) {
    const candidate = asUtc + offsetHours * 3_600_000;
    if (calgaryLocalDateTime(candidate) === local) return candidate;
  }
  return undefined;
}

/**
 * Validates one whole answer row by row. Malformed rows are dropped and counted; above a tenth of
 * the rows, or with no valid row, the whole answer is rejected (fail closed).
 */
export interface ParsedTravelTimes {
  malformed: number;
  rows: Map<string, TravelTimeRow>;
}

export function parseTravelTimes(payload: unknown, nowMs: number): ParsedTravelTimes {
  const rows = RowsSchema.parse(payload);
  const parsed = new Map<string, TravelTimeRow>();
  let malformed = 0;
  for (const raw of rows) {
    const row = RowSchema.safeParse(raw);
    const lastUpdateMs = row.success ? calgaryWallTimeToUtcMs(row.data.last_update) : undefined;
    const minutes = row.success ? Number(row.data.travel_time_mins) : Number.NaN;
    if (
      !row.success ||
      lastUpdateMs === undefined ||
      lastUpdateMs > nowMs + MAX_FUTURE_MS ||
      !Number.isInteger(minutes) ||
      minutes < 1 ||
      minutes > MAX_MINUTES ||
      parsed.has(row.data.road_segment)
    ) {
      malformed += 1;
      continue;
    }
    parsed.set(row.data.road_segment, { lastUpdateMs, minutes });
  }
  if (parsed.size === 0 || malformed > rows.length * MAX_MALFORMED_SHARE) {
    throw new TravelTimesFeedError('The travel-times answer has too many malformed rows.');
  }
  return { malformed, rows: parsed };
}

export function createTravelTimesFeed(options: TravelTimesFeedOptions = {}): TravelTimesFeed {
  const clock = options.clock ?? Date.now;
  const fetchImplementation = options.fetchImplementation ?? fetch;
  const url = options.url ?? TRAVEL_TIMES_URL;
  const pollMs = Math.max(TRAVEL_TIMES_MIN_POLL_MS, options.pollMs ?? TRAVEL_TIMES_POLL_MS);
  const counters: TravelTimesFeedCounters = {
    fetchFailures: 0,
    fetches: 0,
    malformedRows: 0,
    notModified: 0,
    rejectedAnswers: 0,
  };
  let current: TravelTimeSnapshot | undefined;
  let validators: { etag?: string; lastModified?: string } = {};
  let inFlight: Promise<void> | undefined;
  let lastAttemptMs = Number.NEGATIVE_INFINITY;
  let timer: ReturnType<typeof setInterval> | undefined;

  const fetchOnce = async (): Promise<void> => {
    counters.fetches += 1;
    lastAttemptMs = clock();
    try {
      const headers: Record<string, string> = { accept: 'application/json' };
      if (validators.etag !== undefined) headers['if-none-match'] = validators.etag;
      if (validators.lastModified !== undefined) {
        headers['if-modified-since'] = validators.lastModified;
      }
      const response = await fetchImplementation(url, {
        headers,
        redirect: 'follow',
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (response.status === 304 && current !== undefined) {
        counters.notModified += 1;
        current = { ...current, fetchedAtMs: clock() };
        return;
      }
      if (!response.ok) {
        throw new TravelTimesFeedError(
          `The travel-times feed returned ${String(response.status)}.`,
        );
      }
      const payload: unknown = await response.json();
      let parsed: ParsedTravelTimes;
      try {
        parsed = parseTravelTimes(payload, clock());
      } catch (error: unknown) {
        counters.rejectedAnswers += 1;
        throw error;
      }
      counters.malformedRows += parsed.malformed;
      if (parsed.malformed > 0) {
        options.onFailure?.({
          errorName: 'TravelTimesRowParseError',
          malformedRows: parsed.malformed,
        });
      }
      current = { fetchedAtMs: clock(), rows: parsed.rows };
      const etag = response.headers.get('etag');
      const lastModified = response.headers.get('last-modified');
      validators = {
        ...(etag === null ? {} : { etag }),
        ...(lastModified === null ? {} : { lastModified }),
      };
    } catch (error: unknown) {
      // The previous answer stays; its own age decides whether it is still used.
      counters.fetchFailures += 1;
      options.onFailure?.({ errorName: error instanceof Error ? error.name : 'UnknownError' });
    }
  };

  const feed: TravelTimesFeed = {
    counters: () => ({ ...counters }),
    snapshot: () => current,
    async refresh() {
      if (inFlight !== undefined) return inFlight;
      // However often it is asked, the City is never polled faster than the minimum interval.
      if (clock() - lastAttemptMs < TRAVEL_TIMES_MIN_POLL_MS) return;
      inFlight = fetchOnce().finally(() => {
        inFlight = undefined;
      });
      return inFlight;
    },
    start() {
      if (timer !== undefined) return;
      void feed.refresh();
      timer = setInterval(() => void feed.refresh(), pollMs);
      timer.unref();
    },
    stop() {
      clearInterval(timer);
      timer = undefined;
    },
  };
  return feed;
}
