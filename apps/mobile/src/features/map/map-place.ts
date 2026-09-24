import type { Coordinate, SearchResult } from '@navoss/contracts';
import type { Feature, GeoJsonProperties } from 'geojson';

import { mapRegionForCoordinate } from './map-region';

export const MAP_PLACE_LAYER_IDS = ['poi_r1', 'poi_r7', 'poi_r20', 'poi_transit'] as const;
const MAX_DETAILS_DISTANCE_METERS = 150;
const AMBIGUOUS_MATCH_DISTANCE_METERS = 30;
const EARTH_RADIUS_METERS = 6_371_000;

function normalizedName(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLocaleLowerCase('en-CA')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function coordinateDistanceMeters(left: Coordinate, right: Coordinate): number {
  const toRadians = (degrees: number) => (degrees * Math.PI) / 180;
  const latitudeDelta = toRadians(right.latitude - left.latitude);
  const longitudeDelta = toRadians(right.longitude - left.longitude);
  const leftLatitude = toRadians(left.latitude);
  const rightLatitude = toRadians(right.latitude);
  const haversine =
    Math.sin(latitudeDelta / 2) ** 2 +
    Math.cos(leftLatitude) * Math.cos(rightLatitude) * Math.sin(longitudeDelta / 2) ** 2;
  return 2 * EARTH_RADIUS_METERS * Math.asin(Math.sqrt(haversine));
}

function propertyString(
  properties: GeoJsonProperties,
  keys: readonly string[],
): string | undefined {
  for (const key of keys) {
    const value: unknown =
      properties === null ? undefined : (properties as Record<string, unknown>)[key];
    if (typeof value === 'string' && value.trim().length > 0) {
      return value.trim();
    }
  }
  return undefined;
}

export function formatPlaceCategory(value: string): string {
  if (value === 'fuel') return 'Gas station';
  return value
    .split('_')
    .map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
    .join(' ');
}

function featureCoordinate(feature: Feature, fallback: Coordinate): Coordinate {
  if (feature.geometry.type !== 'Point') {
    return fallback;
  }
  const [longitude, latitude] = feature.geometry.coordinates;
  return Number.isFinite(latitude) && Number.isFinite(longitude)
    ? { latitude, longitude }
    : fallback;
}

export function mapPlaceFromRenderedFeatures(
  features: readonly Feature[],
  fallback: Coordinate,
): SearchResult | undefined {
  for (const feature of features) {
    const name = propertyString(feature.properties, ['name_en', 'name:latin', 'name']);
    if (name === undefined) continue;

    const center = featureCoordinate(feature, fallback);
    const category = formatPlaceCategory(
      propertyString(feature.properties, ['subclass', 'class']) ?? 'point of interest',
    );
    const osmId: unknown =
      feature.properties === null
        ? undefined
        : (feature.properties as Record<string, unknown>).osm_id;
    const sourceId = typeof osmId === 'string' || typeof osmId === 'number' ? osmId : feature.id;
    return {
      category: 'poi',
      center,
      confidence: 1,
      id:
        sourceId === undefined
          ? `map-poi:${name}:${center.latitude.toFixed(5)}:${center.longitude.toFixed(5)}`
          : `map-poi:${String(sourceId)}`,
      label: category,
      name,
    };
  }
  return undefined;
}

export function enrichMapPlace(
  place: SearchResult,
  candidates: readonly SearchResult[],
): SearchResult {
  const normalizedPlaceName = normalizedName(place.name);
  const mapOsmId = /^map-poi:([^:]+)$/.exec(place.id)?.[1];
  const identityMatch =
    mapOsmId === undefined
      ? undefined
      : candidates.find(
          (candidate) =>
            /^nominatim:[^:]+:([^:]+)$/.exec(candidate.id)?.[1] === mapOsmId &&
            coordinateDistanceMeters(place.center, candidate.center) <= MAX_DETAILS_DISTANCE_METERS,
        );
  const proximityMatches = candidates
    .filter((candidate) => normalizedName(candidate.name) === normalizedPlaceName)
    .map((candidate) => ({
      candidate,
      distance: coordinateDistanceMeters(place.center, candidate.center),
    }))
    .filter(({ distance }) => distance <= MAX_DETAILS_DISTANCE_METERS)
    .sort(
      (left, right) =>
        left.distance - right.distance || right.candidate.confidence - left.candidate.confidence,
    );
  const nearestMatch = proximityMatches.at(0);
  const secondMatch = proximityMatches.at(1);
  let bestMatch = identityMatch;
  if (bestMatch === undefined && nearestMatch !== undefined) {
    const ambiguous =
      secondMatch !== undefined &&
      secondMatch.distance - nearestMatch.distance < AMBIGUOUS_MATCH_DISTANCE_METERS;
    if (!ambiguous) {
      bestMatch = nearestMatch.candidate;
    }
  }

  if (bestMatch?.details === undefined) {
    return place;
  }

  const candidateAddress = bestMatch.details.address;
  const namePrefix = `${bestMatch.name},`;
  const address =
    candidateAddress === undefined ||
    normalizedName(candidateAddress) === normalizedName(bestMatch.name)
      ? undefined
      : candidateAddress
            .toLocaleLowerCase('en-CA')
            .startsWith(namePrefix.toLocaleLowerCase('en-CA'))
        ? candidateAddress.slice(namePrefix.length).trim()
        : candidateAddress;
  const details = {
    ...bestMatch.details,
    ...(address === undefined ? {} : { address }),
  };

  return {
    ...place,
    ...(Object.keys(details).length === 0 ? {} : { details }),
  };
}

export function openStreetMapPlaceUrl(place: SearchResult): string {
  const latitude = place.center.latitude.toFixed(6);
  const longitude = place.center.longitude.toFixed(6);
  return `https://www.openstreetmap.org/?mlat=${latitude}&mlon=${longitude}#map=18/${latitude}/${longitude}`;
}

export function placeReviewsUrl(place: SearchResult): string {
  const query = `${place.name}, ${place.center.latitude.toFixed(6)}, ${place.center.longitude.toFixed(6)}`;
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(query)}`;
}

export function placeShareMessage(place: SearchResult): string {
  const address = place.details?.address ?? place.label;
  return `${place.name}\n${address}\n${openStreetMapPlaceUrl(place)}`;
}

export function placeWebsiteUrl(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const candidate = /^https?:\/\//i.test(value.trim()) ? value.trim() : `https://${value.trim()}`;
  try {
    const url = new URL(candidate);
    const hostname = url.hostname.toLocaleLowerCase('en-CA');
    if (
      (url.protocol !== 'http:' && url.protocol !== 'https:') ||
      url.username.length > 0 ||
      url.password.length > 0 ||
      !hostname.includes('.') ||
      hostname.endsWith('.local') ||
      /^\d{1,3}(?:\.\d{1,3}){3}$/.test(hostname) ||
      hostname.includes(':')
    ) {
      return undefined;
    }
    url.protocol = 'https:';
    return url.toString();
  } catch {
    return undefined;
  }
}

export function placeWebsiteLabel(value: string | undefined): string | undefined {
  const url = placeWebsiteUrl(value);
  return url === undefined ? undefined : new URL(url).hostname.replace(/^www\./i, '');
}

export function placePhoneUrl(value: string | undefined): string | undefined {
  const firstNumber = value?.split(';')[0]?.trim();
  if (firstNumber === undefined) return undefined;
  const normalized = firstNumber.replace(/[\s().-]/g, '');
  return /^\+?\d{7,15}$/.test(normalized) ? `tel:${normalized}` : undefined;
}

const MINUTES_PER_DAY = 1_440;
const MINUTES_PER_WEEK = MINUTES_PER_DAY * 7;
const CLOSING_SOON_WINDOW_MINUTES = 60;
const OPENING_HOURS_DAY_INDEX = new Map<string, number>([
  ['Mo', 0],
  ['Tu', 1],
  ['We', 2],
  ['Th', 3],
  ['Fr', 4],
  ['Sa', 5],
  ['Su', 6],
]);
// Anything referencing these tokens depends on public/school holidays, seasonal date ranges, or
// freeform comments that a fixed weekly schedule cannot represent reliably. Bail to "unknown"
// rather than guess.
const UNSUPPORTED_OPENING_HOURS_PATTERN =
  /"|PH|SH|sunrise|sunset|dawn|dusk|easter|week|\d{4}|\bJan\b|\bFeb\b|\bMar\b|\bApr\b|\bMay\b|\bJun\b|\bJul\b|\bAug\b|\bSep\b|\bOct\b|\bNov\b|\bDec\b/i;
const OPENING_HOURS_RULE_PATTERN =
  /^([A-Za-z,-]+)\s+(off|closed|\d{2}:\d{2}-\d{2}:\d{2}(?:,\d{2}:\d{2}-\d{2}:\d{2})*)$/;
// Bounded so a long-running session's distinct opening_hours strings cannot grow this cache
// without limit; well above any realistic number of places viewed in one sitting.
const OPENING_HOURS_INTERVAL_CACHE_LIMIT = 300;

export type PlaceOpenStatus = 'closed' | 'closing-soon' | 'open';

// A half-open [start, end) range in minutes since Monday 00:00, local wall-clock time. `end` may
// exceed `MINUTES_PER_WEEK` (an overnight rule bleeding past Sunday into Monday) and `start` may be
// negative (the mirrored copy used to merge that overflow with Monday's own hours below).
type WeekInterval = readonly [start: number, end: number];

function parseOpeningHoursDaySelector(selector: string): number[] | undefined {
  const days: number[] = [];
  for (const token of selector.split(',')) {
    const rangeMatch = /^(Mo|Tu|We|Th|Fr|Sa|Su)-(Mo|Tu|We|Th|Fr|Sa|Su)$/.exec(token);
    if (rangeMatch !== null) {
      const [, startToken, endToken] = rangeMatch;
      const start = OPENING_HOURS_DAY_INDEX.get(startToken);
      const end = OPENING_HOURS_DAY_INDEX.get(endToken);
      if (start === undefined || end === undefined) return undefined;
      for (let index = start, steps = 0; steps < 7; index = (index + 1) % 7, steps += 1) {
        days.push(index);
        if (index === end) break;
      }
      continue;
    }
    const dayIndex = OPENING_HOURS_DAY_INDEX.get(token);
    if (dayIndex === undefined) return undefined;
    days.push(dayIndex);
  }
  return days.length === 0 ? undefined : days;
}

// Compiles OSM `opening_hours` syntax into a small set of merged weekly intervals instead of a
// per-minute timeline. Only unambiguous day-and-time rules are supported; later rules override
// earlier ones for the days they name, matching the spec's precedence. Any unrecognized rule fails
// the whole value to `undefined` so callers never present a fabricated status. Each raw interval is
// mirrored one week earlier and one week later before merging so an overnight rule that bleeds past
// Sunday correctly fuses with Monday's own hours (and 24/7 schedules collapse into one continuous
// span with no false "closing soon" at the week seam).
//
// A later rule that names a day fully replaces that day's hours from midnight, including any
// overnight spillover a previous rule's *different* day would otherwise bleed into it: each day
// tracks which rule (by position in the `;`-separated list) last defined it, and an overnight
// range is clipped to end-of-day whenever the following day was last defined by a *later* rule than
// the one producing the spillover. Days covered by the same rule (e.g. a single `Mo-Su` range) keep
// their natural overnight continuation, since there is no later, more specific rule to defer to.
function compileOpeningHoursIntervals(value: string): WeekInterval[] | undefined {
  if (UNSUPPORTED_OPENING_HOURS_PATTERN.test(value)) return undefined;
  const rules = value
    .split(';')
    .map((rule) => rule.trim())
    .filter((rule) => rule.length > 0);
  if (rules.length === 0) return undefined;

  const dayRanges = new Map<number, [number, number][]>();
  const dayRuleIndex = new Map<number, number>();
  for (const [ruleIndex, rule] of rules.entries()) {
    if (rule === '24/7') {
      for (let day = 0; day < 7; day += 1) {
        dayRanges.set(day, [[0, MINUTES_PER_DAY]]);
        dayRuleIndex.set(day, ruleIndex);
      }
      continue;
    }
    const match = OPENING_HOURS_RULE_PATTERN.exec(rule);
    if (match === null) return undefined;
    const [, daySelector, timesPart] = match;
    const days = parseOpeningHoursDaySelector(daySelector);
    if (days === undefined) return undefined;

    if (timesPart === 'off' || timesPart === 'closed') {
      for (const day of days) {
        dayRanges.set(day, []);
        dayRuleIndex.set(day, ruleIndex);
      }
      continue;
    }
    const ranges: [number, number][] = [];
    for (const range of timesPart.split(',')) {
      const rangeMatch = /^(\d{2}):(\d{2})-(\d{2}):(\d{2})$/.exec(range);
      if (rangeMatch === null) return undefined;
      const [, startHour, startMinute, endHour, endMinute] = rangeMatch;
      if (
        Number(startHour) > 23 ||
        Number(endHour) > 23 ||
        Number(startMinute) > 59 ||
        Number(endMinute) > 59
      ) {
        return undefined;
      }
      const startOfDay = Number(startHour) * 60 + Number(startMinute);
      const rawEnd = Number(endHour) * 60 + Number(endMinute);
      const endOfDay = rawEnd <= startOfDay ? rawEnd + MINUTES_PER_DAY : rawEnd;
      if (endOfDay - startOfDay > MINUTES_PER_DAY) return undefined;
      ranges.push([startOfDay, endOfDay]);
    }
    for (const day of days) {
      dayRanges.set(day, ranges);
      dayRuleIndex.set(day, ruleIndex);
    }
  }

  const raw: [number, number][] = [];
  for (const [day, ranges] of dayRanges) {
    const ownRuleIndex = dayRuleIndex.get(day);
    if (ownRuleIndex === undefined) return undefined;
    const nextRuleIndex = dayRuleIndex.get((day + 1) % 7);
    const clipSpillover = nextRuleIndex !== undefined && nextRuleIndex > ownRuleIndex;
    for (const [start, rawEnd] of ranges) {
      const end = clipSpillover && rawEnd > MINUTES_PER_DAY ? MINUTES_PER_DAY : rawEnd;
      const base = day * MINUTES_PER_DAY;
      raw.push([base + start, base + end]);
      raw.push([base + start - MINUTES_PER_WEEK, base + end - MINUTES_PER_WEEK]);
      raw.push([base + start + MINUTES_PER_WEEK, base + end + MINUTES_PER_WEEK]);
    }
  }
  if (raw.length === 0) return [];

  raw.sort((left, right) => left[0] - right[0]);
  const merged: [number, number][] = [];
  for (const [start, end] of raw) {
    const last = merged.at(-1);
    if (last !== undefined && start <= last[1]) {
      last[1] = Math.max(last[1], end);
    } else {
      merged.push([start, end]);
    }
  }
  return merged;
}

const openingHoursIntervalCache = new Map<string, WeekInterval[] | undefined>();

function openingHoursIntervals(value: string): WeekInterval[] | undefined {
  const cached = openingHoursIntervalCache.get(value);
  if (cached !== undefined || openingHoursIntervalCache.has(value)) return cached;
  if (openingHoursIntervalCache.size >= OPENING_HOURS_INTERVAL_CACHE_LIMIT) {
    openingHoursIntervalCache.clear();
  }
  const compiled = compileOpeningHoursIntervals(value);
  openingHoursIntervalCache.set(value, compiled);
  return compiled;
}

// Minutes until the interval covering `weekMinute` ends. `weekMinute` is always the unshifted
// current-week minute (0..MINUTES_PER_WEEK); the compiler already mirrors and merges overnight and
// week-seam coverage into `intervals` (see `compileOpeningHoursIntervals`), so the interval whose
// stored bounds directly contain `weekMinute` is the authoritative, already-merged answer. Shifting
// `weekMinute` by a week to probe neighbouring mirrored copies is unnecessary and wrong: it can
// match a narrower, unrelated mirrored copy before reaching the correct merged interval. Returns
// `undefined` when `weekMinute` is not covered by any interval (closed).
function minutesUntilClose(
  intervals: readonly WeekInterval[],
  weekMinute: number,
): number | undefined {
  for (const [start, end] of intervals) {
    if (weekMinute >= start && weekMinute < end) return end - weekMinute;
  }
  return undefined;
}

const OPENING_HOURS_WEEKDAY_INDEX: Record<string, number> = {
  Mon: 0,
  Tue: 1,
  Wed: 2,
  Thu: 3,
  Fri: 4,
  Sat: 5,
  Sun: 6,
};

function localWeekMinute(now: Date, timeZone: string): number | undefined {
  const parts = new Intl.DateTimeFormat('en-CA', {
    hour: '2-digit',
    hourCycle: 'h23',
    minute: '2-digit',
    timeZone,
    weekday: 'short',
  }).formatToParts(now);
  const weekdayToken = parts.find((part) => part.type === 'weekday')?.value;
  const hourToken = parts.find((part) => part.type === 'hour')?.value;
  const minuteToken = parts.find((part) => part.type === 'minute')?.value;
  const dayIndex =
    weekdayToken === undefined ? undefined : OPENING_HOURS_WEEKDAY_INDEX[weekdayToken];
  if (dayIndex === undefined || hourToken === undefined || minuteToken === undefined) {
    return undefined;
  }
  const minuteOfDay = (Number(hourToken) % 24) * 60 + Number(minuteToken);
  return dayIndex * MINUTES_PER_DAY + minuteOfDay;
}

// The UTC offset (in minutes east of UTC) a wall clock in `timeZone` shows at `date`, derived from
// the same built-in Intl the rest of this module already relies on rather than a time zone
// database dependency.
function utcOffsetMinutes(date: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    day: '2-digit',
    hour: '2-digit',
    hourCycle: 'h23',
    minute: '2-digit',
    month: '2-digit',
    second: '2-digit',
    timeZone,
    year: 'numeric',
  }).formatToParts(date);
  const value = (type: string) => Number(parts.find((part) => part.type === type)?.value ?? 0);
  const asUtc = Date.UTC(
    value('year'),
    value('month') - 1,
    value('day'),
    value('hour') % 24,
    value('minute'),
    value('second'),
  );
  return Math.round((asUtc - date.getTime()) / 60_000);
}

// The app's search coverage is currently limited to Calgary, AB and Kelowna, BC; each region maps
// to exactly one fixed IANA time zone. Anywhere else returns undefined rather than guessing.
function regionTimeZone(coordinate: Coordinate): string | undefined {
  const region = mapRegionForCoordinate(coordinate);
  if (region === 'calgary-ab') return 'America/Edmonton';
  if (region === 'kelowna-bc') return 'America/Vancouver';
  return undefined;
}

/**
 * Resolves a live Open / Closing soon / Closed status from a place's raw `opening_hours` text and
 * its coordinate, only when both the hours syntax and the coordinate's time zone are reliably
 * known. Returns `undefined` whenever either is unsupported so unknown hours stay unknown.
 *
 * If a daylight-saving transition falls within the next `CLOSING_SOON_WINDOW_MINUTES` of real time,
 * the wall-clock distance to closing no longer equals elapsed time, so this conservatively reports
 * "open" instead of guessing "closing soon".
 */
export function placeOpenStatus(
  place: SearchResult,
  now = new Date(),
): PlaceOpenStatus | undefined {
  const openingHours = place.details?.openingHours;
  if (openingHours === undefined) return undefined;
  const timeZone = regionTimeZone(place.center);
  if (timeZone === undefined) return undefined;
  const intervals = openingHoursIntervals(openingHours);
  if (intervals === undefined) return undefined;
  const weekMinute = localWeekMinute(now, timeZone);
  if (weekMinute === undefined) return undefined;

  const remaining = minutesUntilClose(intervals, weekMinute);
  if (remaining === undefined) return 'closed';
  if (remaining > CLOSING_SOON_WINDOW_MINUTES) return 'open';

  const horizon = new Date(now.getTime() + CLOSING_SOON_WINDOW_MINUTES * 60_000);
  const crossesDstTransition =
    utcOffsetMinutes(now, timeZone) !== utcOffsetMinutes(horizon, timeZone);
  return crossesDstTransition ? 'open' : 'closing-soon';
}

export function placeOpenStatusLabel(status: PlaceOpenStatus): string {
  if (status === 'open') return 'Open now';
  if (status === 'closing-soon') return 'Closing soon';
  return 'Closed';
}
