import type {
  ProvincialRoadEvent,
  ProvincialRoadEventSource,
  ProvincialRoadEventSourceId,
} from '@navoss/contracts';

/**
 * One official road-event source behind the provincial `/v2/events` regions. Each feed loads on
 * its own schedule, keeps its last valid snapshot for at most `maximumAgeSeconds`, and reports
 * its own state; a failing feed never takes another one down. Feeds that need a key the server
 * does not have are inert: they never fetch and report `not-configured`.
 */

export type RoadEventSourceDescriptor = Pick<
  ProvincialRoadEventSource,
  | 'attribution'
  | 'confidence'
  | 'documentationUrl'
  | 'licenseUrl'
  | 'maximumAgeSeconds'
  | 'name'
  | 'refreshIntervalSeconds'
  | 'sourceId'
  | 'timeZone'
>;

export interface RoadEventFeedLoad {
  /** Rows that failed validation and were dropped. */
  droppedRows: number;
  events: ProvincialRoadEvent[];
  /** Rows the source returned, valid or not (excluding explicit "no events" markers). */
  totalRows: number;
  /** The source's own newest timestamp. */
  updatedAt?: string;
}

export interface RoadEventFeedContext {
  fetchJson(url: string, init?: { headers?: Record<string, string> }): Promise<unknown>;
  now: number;
}

export interface RoadEventFeedSnapshot {
  events: ProvincialRoadEvent[];
  source: ProvincialRoadEventSource;
}

export interface RoadEventFeed {
  getSnapshot(): Promise<RoadEventFeedSnapshot>;
  readonly sourceId: ProvincialRoadEventSourceId;
  start(): void;
  stop(): void;
}

export interface RoadEventFeedFailure {
  droppedRows?: number;
  errorName: string;
  sourceId: ProvincialRoadEventSourceId;
}

export interface RoadEventFeedOptions {
  clock?: () => number;
  fetchImplementation?: typeof fetch;
  onFailure?: (failure: RoadEventFeedFailure) => void;
  requestTimeoutMs?: number;
}

export class RoadEventFeedError extends Error {
  public constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'RoadEventFeedError';
  }
}

const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;

/** Isolated bad rows are dropped and counted; more than 10% fails the refresh. */
export function exceedsMalformedRowLimit(droppedRows: number, totalRows: number): boolean {
  return droppedRows > Math.max(1, Math.floor(totalRows * 0.1));
}

/**
 * Whether an event is in effect at `now`: started (or with no start) and not past its planned
 * end. Date-only bounds are whole local days in the source's time zone.
 */
export function isInEffect(event: ProvincialRoadEvent, now: number, timeZone: string): boolean {
  const today = localDate(now, timeZone);
  if (event.startsAt !== undefined && Date.parse(event.startsAt) > now) return false;
  if (event.startsOn !== undefined && event.startsOn > today) return false;
  if (event.endsAt !== undefined) return Date.parse(event.endsAt) > now;
  if (event.endsOn !== undefined) return event.endsOn >= today;
  return true;
}

export function localDate(timestamp: number, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    day: '2-digit',
    month: '2-digit',
    timeZone,
    year: 'numeric',
  }).formatToParts(timestamp);
  const value = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)?.value ?? '';
  return `${value('year')}-${value('month')}-${value('day')}`;
}

/**
 * Converts a wall-clock time in `timeZone` to an instant, following daylight-saving rules. A
 * time inside a spring-forward gap resolves to the instant after the gap; a repeated fall-back
 * time resolves to its first (daylight) occurrence.
 */
export function zonedTimeToInstant(
  local: {
    day: number;
    hour?: number;
    millisecond?: number;
    minute?: number;
    month: number;
    second?: number;
    year: number;
  },
  timeZone: string,
): number {
  const target = Date.UTC(
    local.year,
    local.month - 1,
    local.day,
    local.hour ?? 0,
    local.minute ?? 0,
    local.second ?? 0,
    local.millisecond ?? 0,
  );
  const formatter = new Intl.DateTimeFormat('en-CA', {
    day: '2-digit',
    hour: '2-digit',
    hourCycle: 'h23',
    minute: '2-digit',
    month: '2-digit',
    second: '2-digit',
    timeZone,
    year: 'numeric',
  });
  const offsetAt = (timestamp: number): number => {
    const parts = formatter.formatToParts(timestamp);
    const value = (type: Intl.DateTimeFormatPartTypes) =>
      Number(parts.find((part) => part.type === type)?.value);
    const wall = Date.UTC(
      value('year'),
      value('month') - 1,
      value('day'),
      value('hour'),
      value('minute'),
      value('second'),
      new Date(timestamp).getUTCMilliseconds(),
    );
    return wall - timestamp;
  };
  // Try both offsets around the target; keep the earliest candidate that maps back to it.
  const candidates = [offsetAt(target - 86_400_000), offsetAt(target + 86_400_000)]
    .map((offset) => target - offset)
    .filter((instant) => instant + offsetAt(instant) === target)
    .sort((left, right) => left - right);
  if (candidates[0] !== undefined) return candidates[0];
  // Spring-forward gap: the wall time does not exist; move forward by the gap.
  const before = offsetAt(target - 86_400_000);
  return target - before;
}

/** Parses `YYYY-MM-DD[T ]HH:MM[:SS[.fff]]` without an offset as wall time in `timeZone`. */
export function parseLocalDateTime(value: string, timeZone: string): number | undefined {
  const match = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?)?$/u.exec(
    value.trim(),
  );
  if (match === null) return undefined;
  const [year, month, day, hour, minute, second] = [1, 2, 3, 4, 5, 6].map((index) =>
    Number(match[index] ?? 0),
  ) as [number, number, number, number, number, number];
  if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59 || second > 59) {
    return undefined;
  }
  const instant = zonedTimeToInstant(
    {
      day,
      hour,
      millisecond: Number((match[7] ?? '').padEnd(3, '0')),
      minute,
      month,
      second,
      year,
    },
    timeZone,
  );
  // Reject calendar overflow such as 2026-02-31 (Canadian transitions never cross midnight).
  return localDate(instant, timeZone) === `${match[1]}-${match[2]}-${match[3]}`
    ? instant
    : undefined;
}

export function normalizedText(value: string): string {
  return value
    .replace(/<br\s*\/?>/giu, ' ')
    .replace(/<[^>]*>/gu, ' ')
    .replace(/&#(\d+);/gu, (_match, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&amp;/gu, '&')
    .replace(/&quot;/gu, '"')
    .replace(/&#39;|&apos;/gu, "'")
    .replace(/&nbsp;/gu, ' ')
    .replace(/&lt;/gu, '<')
    .replace(/&gt;/gu, '>')
    .replace(/\s+/gu, ' ')
    .trim();
}

export function truncate(value: string, maximum: number): string {
  return value.length <= maximum ? value : `${value.slice(0, maximum - 1).trimEnd()}…`;
}

export function newestTimestamp(values: readonly (string | undefined)[]): string | undefined {
  let newest: number | undefined;
  for (const value of values) {
    if (value === undefined) continue;
    const time = Date.parse(value);
    if (Number.isFinite(time) && (newest === undefined || time > newest)) newest = time;
  }
  return newest === undefined ? undefined : new Date(newest).toISOString();
}

export function createRoadEventFeed(
  descriptor: RoadEventSourceDescriptor,
  load: ((context: RoadEventFeedContext) => Promise<RoadEventFeedLoad>) | undefined,
  options: RoadEventFeedOptions = {},
): RoadEventFeed {
  const clock = options.clock ?? Date.now;
  const fetchImplementation = options.fetchImplementation ?? fetch;
  const requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const refreshMs = descriptor.refreshIntervalSeconds * 1_000;
  const maximumAgeMs = descriptor.maximumAgeSeconds * 1_000;
  let lastValid:
    | { checkedAt: number; events: ProvincialRoadEvent[]; incomplete: boolean; updatedAt?: string }
    | undefined;
  let lastAttemptAt: number | undefined;
  let lastAttemptFailed = false;
  let refreshing: Promise<void> | undefined;
  let interval: ReturnType<typeof setInterval> | undefined;

  const fetchJson: RoadEventFeedContext['fetchJson'] = async (url, init) => {
    const response = await fetchImplementation(url, {
      headers: { accept: 'application/json', ...init?.headers },
      signal: AbortSignal.timeout(requestTimeoutMs),
    });
    if (!response.ok) {
      throw new RoadEventFeedError(`${descriptor.name} returned ${String(response.status)}.`);
    }
    return response.json();
  };

  const refresh = async (): Promise<void> => {
    if (load === undefined) return;
    const now = clock();
    lastAttemptAt = now;
    try {
      const result = await load({ fetchJson, now });
      if (exceedsMalformedRowLimit(result.droppedRows, result.totalRows)) {
        options.onFailure?.({
          droppedRows: result.droppedRows,
          errorName: 'TooManyMalformedRows',
          sourceId: descriptor.sourceId,
        });
        throw new RoadEventFeedError('Too many malformed rows.');
      }
      if (result.droppedRows > 0) {
        options.onFailure?.({
          droppedRows: result.droppedRows,
          errorName: 'RoadEventRowParseError',
          sourceId: descriptor.sourceId,
        });
      }
      lastValid = {
        checkedAt: now,
        events: result.events,
        incomplete: result.droppedRows > 0,
        ...(result.updatedAt === undefined ? {} : { updatedAt: result.updatedAt }),
      };
      lastAttemptFailed = false;
    } catch (error: unknown) {
      lastAttemptFailed = true;
      if (!(error instanceof RoadEventFeedError && error.message === 'Too many malformed rows.')) {
        options.onFailure?.({
          errorName: error instanceof Error ? error.name : 'UnknownError',
          sourceId: descriptor.sourceId,
        });
      }
    }
  };

  const ensureFresh = (): Promise<void> => {
    const now = clock();
    if (lastAttemptAt !== undefined && now - lastAttemptAt < refreshMs) {
      return refreshing ?? Promise.resolve();
    }
    refreshing ??= refresh().finally(() => {
      refreshing = undefined;
    });
    return refreshing;
  };

  const snapshot = (): RoadEventFeedSnapshot => {
    const now = clock();
    const base = { ...descriptor, eventCount: 0, incomplete: false };
    if (load === undefined) {
      return { events: [], source: { ...base, status: 'not-configured' } };
    }
    if (lastValid === undefined || now - lastValid.checkedAt > maximumAgeMs) {
      return { events: [], source: { ...base, status: 'unavailable' } };
    }
    const events = lastValid.events.filter((event) =>
      isInEffect(event, now, descriptor.timeZone),
    );
    return {
      events,
      source: {
        ...base,
        checkedAt: new Date(lastValid.checkedAt).toISOString(),
        eventCount: events.length,
        incomplete: lastValid.incomplete,
        status: lastAttemptFailed ? 'stale' : 'current',
        ...(lastValid.updatedAt === undefined ? {} : { updatedAt: lastValid.updatedAt }),
      },
    };
  };

  return {
    async getSnapshot() {
      await ensureFresh();
      return snapshot();
    },
    sourceId: descriptor.sourceId,
    start() {
      if (interval !== undefined || load === undefined) return;
      void ensureFresh();
      interval = setInterval(() => void ensureFresh(), refreshMs);
      interval.unref();
    },
    stop() {
      if (interval === undefined) return;
      clearInterval(interval);
      interval = undefined;
    },
  };
}
