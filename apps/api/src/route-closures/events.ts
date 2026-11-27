import {
  PROVINCIAL_ROAD_EVENT_ENVELOPES,
  type ProvincialRoadEventSource,
  type ProvincialRoadEventSourceId,
} from '@navoss/contracts';
import { z } from 'zod/v4';

import { CALGARY_STREET_TYPE_ALIASES } from '../calgary-street-types.js';
import { intervalInstant } from '../drivebc-province-road-event-feed.js';
import {
  parseLocalDateTime,
  type RoadEventFeedSnapshot,
  type RoadEventRoutingRow,
} from '../official-road-event-feed.js';
import { decodePolyline6, type Position } from '../traffic/geo.js';

export type ClosureDirection = 'both' | 'north' | 'east' | 'south' | 'west';
export type ClosureEventRejection =
  | 'unsupported-source'
  | 'unverified'
  | 'source-stale'
  | 'missing-routing-data'
  | 'not-full-closure'
  | 'traffic-still-open'
  | 'not-a-road'
  | 'unknown-direction'
  | 'missing-road-name'
  | 'ambiguous-road'
  | 'not-started'
  | 'expired'
  | 'outside-window'
  | 'schedule-uncertain'
  | 'invalid-geometry'
  | 'malformed-event';

export interface ClosureEvent {
  /** Public source identity, used only to cache public placement. Never included in counters. */
  key: string;
  sourceId: ProvincialRoadEventSourceId;
  direction: ClosureDirection;
  roadNames: readonly string[];
  geometry: readonly Position[];
  geometryType: 'point' | 'line';
}

export interface ClosureSelection {
  events: ClosureEvent[];
  examined: number;
  rejected: Partial<Record<ClosureEventRejection, number>>;
}

class RejectedEvent extends Error {
  public constructor(public readonly reason: ClosureEventRejection) {
    super(reason);
  }
}

const PairSchema = z.tuple([z.number().min(-180).max(180), z.number().min(-90).max(90)]);
const DateOnlySchema = z.iso.date();
const DriveBcRoutingSchema = z
  .object({
    description: z.string().optional(),
    geography: z.union([
      z.object({ type: z.literal('Point'), coordinates: PairSchema }),
      z.object({
        type: z.literal('LineString'),
        coordinates: z.array(PairSchema).min(2).max(16_000),
      }),
    ]),
    roads: z
      .array(
        z
          .object({
            name: z.string().optional(),
            from: z.string().optional(),
            direction: z.string().optional(),
            state: z.string().optional(),
          })
          .loose(),
      )
      .min(1)
      .max(20),
    schedule: z
      .object({
        intervals: z.array(z.string()).max(500).optional(),
        recurring_schedules: z.array(z.unknown()).max(100).optional(),
        exceptions: z.array(z.string()).max(500).optional(),
      })
      .loose(),
    status: z.literal('ACTIVE'),
  })
  .loose();
const Routing511Schema = z
  .object({
    Description: z.string().nullish(),
    Comment: z.string().nullish(),
    Impact: z.string().nullish(),
    EncodedPolyline: z.string().nullish(),
    StartDate: z.number().int().positive().nullish(),
    PlannedEndDate: z.number().int().positive().nullish(),
    Recurrence: z.string().nullish(),
    RecurrenceSchedules: z.unknown().optional(),
  })
  .loose();
const CalgaryRoutingSchema = z
  .object({
    end_dt: z.string().optional(),
    end_dt_utc: z.string().optional(),
  })
  .loose();
const RecurringOpen511Schema = z
  .object({
    start_date: DateOnlySchema.optional(),
    end_date: DateOnlySchema.optional(),
    daily_start_time: z.string().optional(),
    daily_end_time: z.string().optional(),
    days: z.array(z.number().int().min(1).max(7)).min(1).max(7).optional(),
  })
  .strict();
const WEEKDAYS = [
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
  'Sunday',
] as const;
const Recurring511Schema = z
  .array(
    z
      .object({
        StartDate: z.string(),
        EndDate: z.string(),
        DaysOfWeek: z.array(z.enum(WEEKDAYS)).min(1).max(7),
        Times: z
          .array(z.object({ StartTime: z.string(), EndTime: z.string() }).strict())
          .min(1)
          .max(24),
      })
      .strict(),
  )
  .min(1)
  .max(100);
const clockFormatters = new Map<string, Intl.DateTimeFormat>();

/** Exact aliases only: street abbreviations and highway route-number spelling, never fuzzy names. */
export function canonicalClosureRoadName(name: string): string {
  const text = name.normalize('NFKC').toLocaleLowerCase('en-CA').trim();
  const highway = /^(?:(?:highway|hwy|ab|bc|on)\s*[- ]?\s*)?(\d+[a-z]?)$/u.exec(text);
  if (highway?.[1] !== undefined) return `highway:${highway[1]}`;
  return text
    .replace(/\b(\d+)(?:st|nd|rd|th)\b/gu, '$1')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .split(/\s+/u)
    .map((word) => CALGARY_STREET_TYPE_ALIASES[word] ?? word)
    .join(' ');
}

function direction(value: string | undefined): ClosureDirection {
  switch (value?.trim().toLocaleLowerCase('en-CA').replace(/[ -]/gu, '')) {
    case 'both':
    case 'bothdirections':
    case 'alldirections':
      return 'both';
    case 'n':
    case 'nb':
    case 'north':
    case 'northbound':
      return 'north';
    case 'e':
    case 'eb':
    case 'east':
    case 'eastbound':
      return 'east';
    case 's':
    case 'sb':
    case 'south':
    case 'southbound':
      return 'south';
    case 'w':
    case 'wb':
    case 'west':
    case 'westbound':
      return 'west';
    default:
      throw new RejectedEvent('unknown-direction');
  }
}

function clockAt(
  now: number,
  timeZone: string,
): { date: string; seconds: number; weekday: number } {
  let formatter = clockFormatters.get(timeZone);
  if (formatter === undefined) {
    formatter = new Intl.DateTimeFormat('en-CA', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      weekday: 'long',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
      timeZone,
    });
    clockFormatters.set(timeZone, formatter);
  }
  const parts = Object.fromEntries(
    formatter.formatToParts(now).map((part) => [part.type, part.value]),
  );
  const weekday = WEEKDAYS.findIndex((day) => day === parts.weekday);
  if (
    weekday < 0 ||
    parts.year === undefined ||
    parts.month === undefined ||
    parts.day === undefined ||
    parts.hour === undefined ||
    parts.minute === undefined ||
    parts.second === undefined
  ) {
    throw new RejectedEvent('schedule-uncertain');
  }
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    seconds: Number(parts.hour) * 3_600 + Number(parts.minute) * 60 + Number(parts.second),
    weekday,
  };
}

function secondsOfDay(value: string): { seconds: number; offset?: string } {
  const match = /^(\d{2}):(\d{2})(?::(\d{2}))?([+-]\d{2}:\d{2}(?::00)?)?$/u.exec(value);
  if (match === null) throw new RejectedEvent('schedule-uncertain');
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  const seconds = Number(match[3] ?? 0);
  if (hours > 23 || minutes > 59 || seconds > 59) throw new RejectedEvent('schedule-uncertain');
  return {
    seconds: hours * 3_600 + minutes * 60 + seconds,
    ...(match[4] === undefined ? {} : { offset: match[4].slice(0, 6) }),
  };
}

function source511Instant(value: string, timeZone: string): number {
  const match =
    /^(\d{1,2})\/(\d{1,2})\/(\d{4})\s+(\d{1,2}):(\d{2}):(\d{2})\s*(AM|PM)\s*([+-]\d{2}:\d{2})(?::00)?$/iu.exec(
      value,
    );
  if (match === null) throw new RejectedEvent('schedule-uncertain');
  const hour = Number(match[4]);
  if (hour < 1 || hour > 12) throw new RejectedEvent('schedule-uncertain');
  const localHour = (hour % 12) + (match[7]?.toUpperCase() === 'PM' ? 12 : 0);
  const local = `${match[3] ?? ''}-${(match[1] ?? '').padStart(2, '0')}-${(match[2] ?? '').padStart(2, '0')}T${String(localHour).padStart(2, '0')}:${match[5] ?? ''}:${match[6] ?? ''}`;
  const instant = parseLocalDateTime(local, timeZone);
  if (instant === undefined || instant !== Date.parse(`${local}${match[8] ?? ''}`)) {
    throw new RejectedEvent('schedule-uncertain');
  }
  return instant;
}

function offsetAgrees(
  date: string,
  time: { seconds: number; offset?: string },
  timeZone: string,
): boolean {
  if (time.offset === undefined) return true;
  const hour = Math.floor(time.seconds / 3_600);
  const minute = Math.floor((time.seconds % 3_600) / 60);
  const second = time.seconds % 60;
  const local = `${date}T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:${String(second).padStart(2, '0')}`;
  return parseLocalDateTime(local, timeZone) === Date.parse(`${local}${time.offset}`);
}

/** Without structured hours, any temporal prose makes continuous closure status unprovable. */
const UNSTRUCTURED_TIME =
  /\d\s*:\s*\d|\d\s*[ap][\s.]*m\b|\b(?:noon|midnight|overnight|nightly|nights?|evenings?|mornings?|afternoons?|daytime|peak|rush|(?:mon(?:day)?|tue(?:sday)?|wed(?:nesday)?|thu(?:rsday)?|fri(?:day)?|sat(?:urday)?|sun(?:day)?)s?|weekdays?|weekends?|daily|each|every)\b/iu;

function unevaluableHours(description: string): boolean {
  return UNSTRUCTURED_TIME.test(description);
}

/** Only the publisher's complete, labelled update notices are metadata rather than road hours. */
function driveBcClosureText(description: string): string {
  return description.replace(
    /\b(?:last|next) update:\s*\p{L}+\s+\d{1,2}(?:st|nd|rd|th)?,\s*\d{4}\s+at\s+\d{1,2}:\d{2}\s*[ap]\.?m\.?\s+(?:PCT|PST|PDT|MST|MDT)\.(?=\s|$)/giu,
    '',
  );
}

function assertFullRoad(description: string): void {
  if (
    /\b(?:single[- ]lane alternating|two[- ]way traffic|traffic (?:will be )?(?:shifted|using)|some lanes (?:may be )?open)\b/iu.test(
      description,
    )
  ) {
    throw new RejectedEvent('traffic-still-open');
  }
}

function assertInstantWindow(
  startsAt: string | undefined,
  endsAt: string | undefined,
  now: number,
): void {
  if (startsAt === undefined) throw new RejectedEvent('schedule-uncertain');
  const start = Date.parse(startsAt);
  const end = endsAt === undefined ? Infinity : Date.parse(endsAt);
  if (!Number.isFinite(start) || Number.isNaN(end) || end <= start)
    throw new RejectedEvent('schedule-uncertain');
  if (start > now) throw new RejectedEvent('not-started');
  if (end <= now) throw new RejectedEvent('expired');
}

function open511Window(
  schedule: z.infer<typeof DriveBcRoutingSchema>['schedule'],
  description: string,
  now: number,
  timeZone: string,
): void {
  const intervals = schedule.intervals ?? [];
  const recurring = schedule.recurring_schedules ?? [];
  if ((intervals.length === 0) === (recurring.length === 0))
    throw new RejectedEvent('schedule-uncertain');
  if (intervals.length > 0) {
    const periods = intervals.map((interval) => {
      const bounds = interval.split('/');
      if (bounds.length !== 2 || bounds[0] === '') throw new RejectedEvent('schedule-uncertain');
      const instant = (value: string) => {
        if (!DateOnlySchema.safeParse(value.slice(0, 10)).success)
          throw new RejectedEvent('schedule-uncertain');
        // Reuse the feed's UTC interpretation and canonicalisation, including minute-only bounds.
        const canonical = intervalInstant(value);
        if (canonical === undefined) throw new RejectedEvent('schedule-uncertain');
        return Date.parse(canonical);
      };
      const start = instant(bounds[0] ?? '');
      const end = bounds[1] === '' ? Infinity : instant(bounds[1] ?? '');
      if (end <= start) throw new RejectedEvent('schedule-uncertain');
      return { start, end };
    });
    if (periods.some((period) => period.start <= now && now < period.end)) {
      if (
        unevaluableHours(driveBcClosureText(description)) ||
        (schedule.exceptions?.length ?? 0) > 0
      )
        throw new RejectedEvent('schedule-uncertain');
      return;
    }
    if (periods.every((period) => period.start > now)) throw new RejectedEvent('not-started');
    if (periods.every((period) => period.end <= now)) throw new RejectedEvent('expired');
    throw new RejectedEvent('outside-window');
  }
  const local = clockAt(now, timeZone);
  const exceptions = (schedule.exceptions ?? []).map((value) => {
    const [date, ...times] = value.trim().split(/\s+/u);
    if (!DateOnlySchema.safeParse(date).success) throw new RejectedEvent('schedule-uncertain');
    return {
      date,
      periods: times.map((time) => {
        const [from, to, extra] = time.split('-');
        if (from === undefined || to === undefined || extra !== undefined)
          throw new RejectedEvent('schedule-uncertain');
        const start = secondsOfDay(from).seconds;
        const end = secondsOfDay(to).seconds;
        if (end < start) throw new RejectedEvent('schedule-uncertain');
        return { start, end };
      }),
    };
  });
  const components = recurring.map((input) => {
    const parsed = RecurringOpen511Schema.safeParse(input);
    if (!parsed.success) throw new RejectedEvent('schedule-uncertain');
    const row = parsed.data;
    if (
      row.start_date === undefined ||
      (row.end_date !== undefined && row.end_date < row.start_date)
    )
      throw new RejectedEvent('schedule-uncertain');
    if ((row.daily_start_time === undefined) !== (row.daily_end_time === undefined))
      throw new RejectedEvent('schedule-uncertain');
    const start =
      row.daily_start_time === undefined ? 0 : secondsOfDay(row.daily_start_time).seconds;
    const end =
      row.daily_end_time === undefined ? 86_400 : secondsOfDay(row.daily_end_time).seconds;
    // Open511's daily components do not span midnight; the source must split them across days.
    if (end < start) throw new RejectedEvent('schedule-uncertain');
    return { row, start, end };
  });
  const overrides = exceptions.filter((exception) => exception.date === local.date);
  if (overrides.length > 0) {
    if (
      overrides.some((override) =>
        override.periods.some(
          (period) => local.seconds >= period.start && local.seconds <= period.end,
        ),
      )
    )
      return;
    throw new RejectedEvent('outside-window');
  }
  if (
    components.some(
      ({ row, start, end }) =>
        (row.start_date ?? '') <= local.date &&
        (row.end_date === undefined || local.date <= row.end_date) &&
        (row.days === undefined || row.days.includes(local.weekday + 1)) &&
        local.seconds >= start &&
        local.seconds <= end,
    )
  )
    return;
  throw new RejectedEvent('outside-window');
}

function window511(
  input: z.infer<typeof Routing511Schema>,
  description: string,
  now: number,
  timeZone: string,
): void {
  const raw = input.RecurrenceSchedules;
  const absent =
    raw === undefined || raw === null || raw === '' || (Array.isArray(raw) && raw.length === 0);
  if (absent) {
    if (
      (input.Recurrence?.trim() ?? '') !== '' ||
      [description, input.Description, input.Comment, input.Impact].some(
        (text) => text != null && unevaluableHours(text),
      )
    )
      throw new RejectedEvent('schedule-uncertain');
    return;
  }
  const parsed = Recurring511Schema.safeParse(raw);
  if (!parsed.success) throw new RejectedEvent('schedule-uncertain');
  const local = clockAt(now, timeZone);
  // A preceding local day matters for explicitly overnight 511 time windows.
  const previousDay = new Date(`${local.date}T12:00:00Z`);
  previousDay.setUTCDate(previousDay.getUTCDate() - 1);
  const previousDate = previousDay.toISOString().slice(0, 10);
  let active = false;
  for (const row of parsed.data) {
    const from = source511Instant(row.StartDate, timeZone);
    const until = source511Instant(row.EndDate, timeZone);
    if (until <= from) throw new RejectedEvent('schedule-uncertain');
    for (const range of row.Times) {
      const start = secondsOfDay(range.StartTime);
      const end = secondsOfDay(range.EndTime);
      if (start.seconds === end.seconds) throw new RejectedEvent('schedule-uncertain');
      const overnight = end.seconds < start.seconds;
      const afterMidnight = overnight && local.seconds <= end.seconds;
      const anchorDate = afterMidnight ? previousDate : local.date;
      const anchorWeekday = afterMidnight ? (local.weekday + 6) % 7 : local.weekday;
      const endDay = new Date(`${anchorDate}T12:00:00Z`);
      if (overnight) endDay.setUTCDate(endDay.getUTCDate() + 1);
      const endDate = endDay.toISOString().slice(0, 10);
      if (!offsetAgrees(anchorDate, start, timeZone) || !offsetAgrees(endDate, end, timeZone))
        throw new RejectedEvent('schedule-uncertain');
      const weekday = WEEKDAYS[anchorWeekday];
      if (weekday === undefined) throw new RejectedEvent('schedule-uncertain');
      if (
        now >= from &&
        now < until &&
        row.DaysOfWeek.includes(weekday) &&
        (overnight
          ? local.seconds >= start.seconds || afterMidnight
          : local.seconds >= start.seconds && local.seconds <= end.seconds)
      )
        active = true;
    }
  }
  if (!active) throw new RejectedEvent('outside-window');
}

function calgaryRoadName(location: string): string {
  const primary = location.split(/\s+(?:between|at|b\/w)\b/iu)[0]?.trim() ?? '';
  if (primary === '' || /\s(?:and|&)\s/iu.test(primary)) throw new RejectedEvent('ambiguous-road');
  const quadrant = /\b(?:NE|NW|SE|SW)\s*$/iu.exec(location)?.[0]?.trim();
  return quadrant !== undefined && !/\b(?:NE|NW|SE|SW)$/iu.test(primary)
    ? `${primary} ${quadrant}`
    : primary;
}

export function selectClosureEvents(
  snapshots: readonly RoadEventFeedSnapshot[],
  now: number,
): ClosureSelection {
  const selection: ClosureSelection = { events: [], examined: 0, rejected: {} };
  const reject = (reason: ClosureEventRejection, count = 1) => {
    selection.rejected[reason] = (selection.rejected[reason] ?? 0) + count;
  };
  for (const snapshot of snapshots) {
    const { source } = snapshot;
    const rows = snapshot.routingRows ?? [];
    const count = Math.max(1, rows.length);
    if (
      ![
        'calgary-construction-detours',
        'calgary-current-incidents',
        'alberta-511-events',
        'ontario-511-events',
        'drivebc-open511-events',
      ].includes(source.sourceId)
    ) {
      reject('unsupported-source', snapshot.events.length);
      continue;
    }
    selection.examined += rows.length;
    if (source.confidence !== 'official') {
      reject('unverified', count);
      continue;
    }
    const checked = source.checkedAt === undefined ? NaN : Date.parse(source.checkedAt);
    if (
      source.status !== 'current' ||
      !Number.isFinite(checked) ||
      checked > now ||
      now - checked > source.maximumAgeSeconds * 1_000
    ) {
      reject('source-stale', count);
      continue;
    }
    if (source.sourceId === 'calgary-construction-detours') {
      const published = source.updatedAt === undefined ? NaN : Date.parse(source.updatedAt);
      if (!Number.isFinite(published) || published > now || now - published > 24 * 3_600_000) {
        reject('source-stale', count);
        continue;
      }
    }
    if (snapshot.routingRows === undefined) {
      reject('missing-routing-data', snapshot.events.length);
      continue;
    }
    for (const row of rows) {
      try {
        for (const event of closureEvents(row, source, now)) {
          event.key = `${source.sourceId}:${String(checked)}:${event.key}`;
          selection.events.push(event);
        }
      } catch (error: unknown) {
        reject(error instanceof RejectedEvent ? error.reason : 'malformed-event');
      }
    }
  }
  selection.events.sort((left, right) => left.key.localeCompare(right.key, 'en-CA'));
  return selection;
}

function closureEvents(
  pair: RoadEventRoutingRow,
  source: ProvincialRoadEventSource,
  now: number,
): ClosureEvent[] {
  const { event, row: input } = pair;
  if (event.sourceId !== source.sourceId || event.confidence !== source.confidence)
    throw new RejectedEvent('malformed-event');
  if (source.sourceId === 'calgary-construction-detours') {
    assertFullRoad(event.description);
    if (
      !/(?:^|[.;])\s*(?:24\/7\s+)?(?:full road closure|road closure|road closed)\b|\b(?:north|south|east|west)\s*(?:bound)?\s+full\s+(?:road\s+)?closure\b/iu.test(
        event.description,
      )
    )
      throw new RejectedEvent('not-full-closure');
    if (unevaluableHours(event.description)) throw new RejectedEvent('schedule-uncertain');
    const timing = CalgaryRoutingSchema.parse(input);
    if (
      (timing.end_dt !== undefined || timing.end_dt_utc !== undefined) &&
      event.endsAt === undefined
    )
      throw new RejectedEvent('schedule-uncertain');
    assertInstantWindow(event.startsAt, event.endsAt, now);
    const name = calgaryRoadName(event.roadwayName ?? '');
    const target =
      /\b(?:full road closure|road closure|road closed)\s+(?:on|of)\s+(.+?)(?:\s+(?:between|b\/w|at)\b|[.;]|$)/iu.exec(
        event.description,
      )?.[1];
    if (
      target !== undefined &&
      canonicalClosureRoadName(calgaryRoadName(target)) !== canonicalClosureRoadName(name)
    )
      throw new RejectedEvent('ambiguous-road');
    const stated = /\b(north|south|east|west)\s*(?:bound)?\s+full\s+(?:road\s+)?closure\b/iu.exec(
      event.description,
    )?.[1];
    return [
      {
        key: event.id,
        sourceId: source.sourceId,
        direction: stated === undefined ? 'both' : direction(stated),
        roadNames: [name],
        geometryType: 'point',
        geometry: [[event.coordinate.longitude, event.coordinate.latitude]],
      },
    ];
  }
  if (source.sourceId === 'alberta-511-events' || source.sourceId === 'ontario-511-events') {
    const province = source.sourceId === 'alberta-511-events' ? 'alberta' : 'ontario';
    if (event.isFullClosure !== true) throw new RejectedEvent('not-full-closure');
    assertFullRoad(event.description);
    if (/\b(?:ferry|rest area|parking lot)\b/iu.test(event.roadwayName ?? ''))
      throw new RejectedEvent('not-a-road');
    const row = Routing511Schema.parse(input);
    if (
      row.StartDate == null ||
      (row.PlannedEndDate != null && row.PlannedEndDate <= row.StartDate)
    )
      throw new RejectedEvent('schedule-uncertain');
    assertInstantWindow(event.startsAt, event.endsAt, now);
    window511(row, event.description, now, source.timeZone);
    const geometry =
      row.EncodedPolyline == null || row.EncodedPolyline.trim() === ''
        ? [[event.coordinate.longitude, event.coordinate.latitude] as Position]
        : decodePolyline6(row.EncodedPolyline).map(([longitude, latitude]): Position => [
            longitude * 10,
            latitude * 10,
          ]);
    const envelope = PROVINCIAL_ROAD_EVENT_ENVELOPES[province];
    if (
      geometry.length === 0 ||
      geometry.length > 16_000 ||
      geometry.some(
        ([lon, lat]) =>
          !Number.isFinite(lon) ||
          !Number.isFinite(lat) ||
          lon < envelope.west ||
          lon > envelope.east ||
          lat < envelope.south ||
          lat > envelope.north,
      )
    )
      throw new RejectedEvent('invalid-geometry');
    if (geometry.length === 1 && event.roadwayName === undefined)
      throw new RejectedEvent('missing-road-name');
    return [
      {
        key: event.id,
        sourceId: source.sourceId,
        direction: direction(event.direction),
        roadNames: event.roadwayName === undefined ? [] : [event.roadwayName],
        geometryType: geometry.length > 1 ? 'line' : 'point',
        geometry,
      },
    ];
  }
  if (source.sourceId === 'drivebc-open511-events') {
    const row = DriveBcRoutingSchema.parse(input);
    if (row.roads.length !== 1) throw new RejectedEvent('ambiguous-road');
    const road = row.roads[0];
    if (road?.state !== 'CLOSED') throw new RejectedEvent('not-full-closure');
    const roadNames = [road.name, road.from].filter(
      (name): name is string =>
        name !== undefined && name.trim() !== '' && !/^(?:other roads|unknown)$/iu.test(name),
    );
    if (roadNames.some((name) => /\b(?:ferry|rest area|parking lot)\b/iu.test(name)))
      throw new RejectedEvent('not-a-road');
    const description = row.description ?? event.description;
    assertFullRoad(description);
    // UTC interval bounds work province-wide. Recurring local hours need a confirmed time zone.
    const geometry: Position[] =
      row.geography.type === 'Point' ? [row.geography.coordinates] : row.geography.coordinates;
    const bounds = PROVINCIAL_ROAD_EVENT_ENVELOPES['british-columbia'];
    if (
      geometry.some(
        ([lon, lat]) =>
          lon < bounds.west || lon > bounds.east || lat < bounds.south || lat > bounds.north,
      )
    )
      throw new RejectedEvent('invalid-geometry');
    if (
      (row.schedule.recurring_schedules?.length ?? 0) > 0 &&
      (source.timeZone !== 'America/Vancouver' ||
        !geometry.every(([longitude, latitude]) => longitude < -122 && latitude < 55))
    )
      throw new RejectedEvent('schedule-uncertain');
    // This conservative Pacific core excludes the northeastern and southeastern local-time
    // exceptions, and leaves boundary/other unconfirmed areas unused rather than assigning a zone.
    open511Window(row.schedule, description, now, source.timeZone);
    if (geometry.length === 1 && roadNames.length === 0)
      throw new RejectedEvent('missing-road-name');
    return [
      {
        key: `${event.id}:0`,
        sourceId: source.sourceId,
        direction: direction(road.direction),
        roadNames,
        geometryType: row.geography.type === 'Point' ? 'point' : 'line',
        geometry,
      },
    ];
  }
  throw new RejectedEvent('unsupported-source');
}
