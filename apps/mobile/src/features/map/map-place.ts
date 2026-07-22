import type { Coordinate, SearchResult } from '@navoss/contracts';
import type { Feature, GeoJsonProperties } from 'geojson';

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

function placeCategory(properties: GeoJsonProperties): string {
  const value = propertyString(properties, ['subclass', 'class']) ?? 'point of interest';
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
    const category = placeCategory(feature.properties);
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
