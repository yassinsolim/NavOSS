import type {
  KelownaRoadEvent,
  OfficialRoadEventResponse,
  ProvincialRoadEvent,
  ProvincialRoadEventRegion,
  ProvincialRoadEventResponse,
  ProvincialRoadEventSource,
  RoadEvent,
  RoadEventResponse,
} from '@navoss/contracts';

import type { MapRegion } from '@/features/map/map-region';

/**
 * Official road events on the phone: which feed a map region reads, which events are still in
 * effect, newest-first ordering, and how age and source state are worded. Ages always come from
 * the source's own timestamps, never from when NavOSS fetched them.
 */

export type MapRoadEvent = RoadEvent | KelownaRoadEvent | ProvincialRoadEvent;
export type RoadEventSnapshot = OfficialRoadEventResponse | RoadEventResponse;
/** Feeds of servers before the provincial regions: `/v1/events` (Calgary) and Kelowna's v2 shape. */
export type LegacyRoadEventRegion = 'calgary' | 'kelowna-bc';

export interface RoadEventFeedChoice {
  legacy: LegacyRoadEventRegion | undefined;
  provincial: ProvincialRoadEventRegion | undefined;
}

export function isProvincialSnapshot(
  snapshot: RoadEventSnapshot | undefined,
): snapshot is ProvincialRoadEventResponse {
  return snapshot !== undefined && 'sources' in snapshot && 'regionId' in snapshot;
}

/**
 * The provincial region for a map region, and the older feed to use when the server predates the
 * provincial regions (it answers 400 for an unknown region, 404 without the endpoint).
 */
export function roadEventFeedForMapRegion(mapRegion: MapRegion | undefined): RoadEventFeedChoice {
  switch (mapRegion) {
    case 'calgary-ab':
      return { legacy: 'calgary', provincial: 'alberta' };
    case 'alberta':
      return { legacy: undefined, provincial: 'alberta' };
    case 'kelowna-bc':
      return { legacy: 'kelowna-bc', provincial: 'british-columbia' };
    case 'british-columbia':
      return { legacy: undefined, provincial: 'british-columbia' };
    case 'ontario':
      return { legacy: undefined, provincial: 'ontario' };
    default:
      return { legacy: undefined, provincial: undefined };
  }
}

/** When the source last changed the event, for ordering and the "Updated … ago" line. */
export function roadEventSourceTime(
  event: MapRoadEvent,
): { kind: 'reported' | 'started' | 'updated'; time: number } | undefined {
  if (!('regionId' in event)) return undefined;
  const candidates: ['reported' | 'started' | 'updated', string | undefined][] = [
    ['updated', event.updatedAt],
    ['reported', event.reportedAt],
    ['started', event.startsAt],
  ];
  for (const [kind, value] of candidates) {
    const time = value === undefined ? Number.NaN : Date.parse(value);
    if (Number.isFinite(time)) return { kind, time };
  }
  return undefined;
}

function localToday(now: number, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    day: '2-digit',
    month: '2-digit',
    timeZone,
    year: 'numeric',
  }).formatToParts(now);
  const value = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)?.value ?? '';
  return `${value('year')}-${value('month')}-${value('day')}`;
}

/** Whether a source's snapshot may still be shown (`current` or `stale` inside its bound). */
export function isSourceServed(source: ProvincialRoadEventSource, now: number): boolean {
  if (source.status !== 'current' && source.status !== 'stale') return false;
  if (source.checkedAt === undefined) return false;
  return now - Date.parse(source.checkedAt) <= source.maximumAgeSeconds * 1_000;
}

/**
 * Events still in effect at `now`, newest first. A phone keeps its last response through failed
 * refreshes, so events of a source past its maximum age, and events past their planned end, are
 * dropped here as well as on the server.
 */
export function currentRoadEvents(
  snapshot: RoadEventSnapshot | undefined,
  now: number,
): readonly MapRoadEvent[] {
  if (snapshot === undefined) return [];
  if (!isProvincialSnapshot(snapshot)) return snapshot.events;
  const sources = new Map(snapshot.sources.map((source) => [source.sourceId, source]));
  return snapshot.events
    .filter((event) => {
      const source = sources.get(event.sourceId);
      if (source === undefined || !isSourceServed(source, now)) return false;
      if (event.endsAt !== undefined && Date.parse(event.endsAt) <= now) return false;
      if (event.endsOn !== undefined && event.endsOn < localToday(now, source.timeZone)) {
        return false;
      }
      return true;
    })
    .sort((left, right) => {
      const leftTime = roadEventSourceTime(left)?.time ?? Number.NEGATIVE_INFINITY;
      const rightTime = roadEventSourceTime(right)?.time ?? Number.NEGATIVE_INFINITY;
      if (leftTime !== rightTime) return rightTime - leftTime;
      const leftDate = left.startsOn ?? left.reportedOn ?? '';
      const rightDate = right.startsOn ?? right.reportedOn ?? '';
      return leftDate === rightDate
        ? left.id.localeCompare(right.id, 'en-CA')
        : rightDate.localeCompare(leftDate, 'en-CA');
    });
}

/** "just now", "12 min ago", "3 h ago", "2 days ago". Future source times read as "just now". */
export function relativeAge(time: number, now: number): string {
  const minutes = Math.floor(Math.max(0, now - time) / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${String(minutes)} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${String(hours)} h ago`;
  const days = Math.floor(hours / 24);
  return `${String(days)} ${days === 1 ? 'day' : 'days'} ago`;
}

const DATE_FORMAT = new Intl.DateTimeFormat('en-CA', { day: 'numeric', month: 'short' });

function formatLocalDate(value: string): string {
  const [year, month, day] = value.split('-').map(Number);
  return DATE_FORMAT.format(new Date(Date.UTC(year ?? 0, (month ?? 1) - 1, day ?? 1, 12)));
}

/** The age line under an event: from the source's own timestamps only. */
export function roadEventAgeLabel(event: MapRoadEvent, now: number): string | undefined {
  const sourceTime = roadEventSourceTime(event);
  if (sourceTime !== undefined) {
    const verb =
      sourceTime.kind === 'updated'
        ? 'Updated'
        : sourceTime.kind === 'reported'
          ? 'Reported'
          : 'Started';
    return `${verb} ${relativeAge(sourceTime.time, now)}`;
  }
  if ('startsOn' in event && event.startsOn !== undefined) {
    return `Since ${formatLocalDate(event.startsOn)}`;
  }
  return undefined;
}

const TYPE_LABELS: Readonly<Record<MapRoadEvent['type'], string>> = {
  closure: 'Closure',
  collision: 'Collision',
  construction: 'Construction',
  hazard: 'Hazard',
  incident: 'Incident',
  'road-condition': 'Road conditions',
  'special-event': 'Special event',
  'stalled-vehicle': 'Stalled vehicle',
};

export function roadEventTypeLabel(event: MapRoadEvent): string {
  return TYPE_LABELS[event.type];
}

/** Which of the three map symbol layers draws an event. */
export function roadEventLayer(event: MapRoadEvent): 'closure' | 'construction' | 'incident' {
  if (event.type === 'closure' || event.type === 'construction') return event.type;
  return 'incident';
}

export function roadEventSourceName(
  event: MapRoadEvent,
  snapshot: RoadEventSnapshot | undefined,
): string {
  if (isProvincialSnapshot(snapshot)) {
    const source = snapshot.sources.find((candidate) => candidate.sourceId === event.sourceId);
    if (source !== undefined) return source.name;
  }
  if ('regionId' in event) return 'DriveBC';
  return event.confidence === 'official'
    ? 'City of Calgary construction'
    : 'City of Calgary incidents';
}

/** "Official" or "Unverified", as each source describes itself. */
export function roadEventConfidenceLabel(event: MapRoadEvent): string {
  return event.confidence === 'official' ? 'Official' : 'Unverified';
}

const TIME_FORMAT = new Intl.DateTimeFormat('en-CA', {
  day: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
  month: 'short',
});

/** Detail text for a tapped or listed event. */
export function roadEventMessage(
  event: MapRoadEvent,
  snapshot: RoadEventSnapshot | undefined,
  now: number,
): string {
  if (!('regionId' in event)) {
    const confidence =
      event.confidence === 'official'
        ? 'Official City of Calgary construction information'
        : 'Unverified current incident information';
    const end =
      event.endsAtLocal === undefined ? '' : `\nEnds: ${event.endsAtLocal.replace('T', ' ')}`;
    return `${confidence}\n\n${event.description}\n\nStarts: ${event.startsAtLocal.replace('T', ' ')}${end}\nTime zone: America/Edmonton`;
  }
  const source = roadEventSourceName(event, snapshot);
  const header =
    event.confidence === 'official'
      ? `Official ${source} road information`
      : `Unverified ${source} information`;
  const facts = [
    'severity' in event && event.severity !== undefined
      ? `Severity: ${event.severity[0]?.toUpperCase() ?? ''}${event.severity.slice(1)}`
      : undefined,
    event.roadwayName === undefined
      ? undefined
      : `Road: ${event.roadwayName}${event.direction === undefined ? '' : `, ${event.direction}`}`,
    event.startsAt !== undefined
      ? `Starts: ${TIME_FORMAT.format(Date.parse(event.startsAt))}`
      : 'startsOn' in event && event.startsOn !== undefined
        ? `Starts: ${formatLocalDate(event.startsOn)}`
        : undefined,
    event.endsAt !== undefined
      ? `Planned end: ${TIME_FORMAT.format(Date.parse(event.endsAt))}`
      : 'endsOn' in event && event.endsOn !== undefined
        ? `Planned end: ${formatLocalDate(event.endsOn)}`
        : undefined,
    roadEventAgeLabel(event, now),
  ].filter((line): line is string => line !== undefined);
  return `${header}\n\n${event.description}\n\n${facts.join('\n')}`;
}

/** Credits for the map attribution line, from the sources actually drawn. */
export function roadEventCredit(
  snapshot: RoadEventSnapshot | undefined,
  now: number,
): string | undefined {
  if (snapshot === undefined) return undefined;
  if (!isProvincialSnapshot(snapshot)) {
    return 'sources' in snapshot ? '© City of Calgary' : 'DriveBC';
  }
  const names = snapshot.sources
    .filter((source) => isSourceServed(source, now))
    .map((source) => source.name.replace(/ (?:construction|incidents)$/u, ''));
  const unique = [...new Set(names)];
  return unique.length === 0 ? undefined : unique.join(' · ');
}

export interface RoadEventSourceLine {
  sourceId: string;
  text: string;
  tone: 'neutral' | 'warning';
}

/**
 * One line per provincial source for the events list: what it is, how fresh, and whether it is
 * missing. A stale or unavailable feed is said so, never shown as current.
 */
export function roadEventSourceLines(
  snapshot: ProvincialRoadEventResponse,
  now: number,
): RoadEventSourceLine[] {
  return snapshot.sources.map((source) => {
    const label = `${source.name} · ${source.confidence === 'official' ? 'Official' : 'Unverified'}`;
    if (source.status === 'not-configured') {
      return {
        sourceId: source.sourceId,
        text: `${source.name} · Not connected on this server`,
        tone: 'neutral',
      };
    }
    if (!isSourceServed(source, now)) {
      return {
        sourceId: source.sourceId,
        text: `${source.name} · Unavailable right now`,
        tone: 'warning',
      };
    }
    const updated =
      source.updatedAt === undefined
        ? ''
        : ` · Updated ${relativeAge(Date.parse(source.updatedAt), now)}`;
    if (source.status === 'stale') {
      return {
        sourceId: source.sourceId,
        text: `${label}${updated} · Not refreshing, showing the last copy`,
        tone: 'warning',
      };
    }
    return {
      sourceId: source.sourceId,
      text: `${label}${updated}${source.incomplete ? ' · Some entries could not be read' : ''}`,
      tone: source.incomplete ? 'warning' : 'neutral',
    };
  });
}

/** Source and freshness pill on the map. Undefined when the overlay is off or not published. */
export function roadEventStatusLabel({
  hasFeed,
  now,
  refreshDelayed,
  snapshot,
}: {
  hasFeed: boolean;
  now: number;
  refreshDelayed: boolean;
  snapshot: RoadEventSnapshot | undefined;
}): string | undefined {
  if (snapshot === undefined)
    return hasFeed && refreshDelayed ? 'Road events unavailable' : undefined;
  const delayed = refreshDelayed ? ' · Refresh delayed' : '';
  if (!isProvincialSnapshot(snapshot)) {
    const source =
      'sources' in snapshot
        ? 'Road events · City of Calgary · Incidents unverified'
        : 'Road events · DriveBC · Official';
    return `${source}${snapshot.stale ? ' · Stale snapshot' : ''}${delayed}`;
  }
  const served = snapshot.sources.filter((source) => isSourceServed(source, now));
  const unverified = served.some((source) => source.confidence === 'unverified');
  const missing = snapshot.sources.some(
    (source) => source.status !== 'not-configured' && !isSourceServed(source, now),
  );
  const stale = served.some((source) => source.status === 'stale');
  return [
    `Road events · ${String(currentRoadEvents(snapshot, now).length)}`,
    unverified ? 'Some unverified' : 'Official',
    stale ? 'Some not refreshing' : undefined,
    missing ? 'Some sources unavailable' : undefined,
  ]
    .filter((part): part is string => part !== undefined)
    .join(' · ')
    .concat(delayed);
}
