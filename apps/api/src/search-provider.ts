import {
  CALGARY_REGION_BOUNDS,
  isCoordinateInBounds,
  isCoordinateInServiceCoverage,
  SERVICE_COVERAGE_BOUNDS,
  type SearchCategory,
  type SearchQuery,
  type SearchResponse,
  type SearchResult,
} from '@navoss/contracts';
import { z } from 'zod/v4';

import { createPostgresCalgarySearchProvider } from './calgary-search-provider.js';
import { CALGARY_SEARCH_FIXTURES, type SearchFixture } from './fixtures.js';
import { searchFixtures } from './search.js';
import { normalizeSearchText, placeSearchQueryVariants } from './search-text.js';
import {
  canonicalSearchName,
  searchLocation,
  searchNameConfidence,
  type SearchLocation,
} from './search-presentation.js';

const DEFAULT_PHOTON_URL = 'https://photon.komoot.io/api/';
const PHOTON_TIMEOUT_MS = 3_000;
const SEARCH_BOUNDS = [
  SERVICE_COVERAGE_BOUNDS.southWest.longitude,
  SERVICE_COVERAGE_BOUNDS.southWest.latitude,
  SERVICE_COVERAGE_BOUNDS.northEast.longitude,
  SERVICE_COVERAGE_BOUNDS.northEast.latitude,
].join(',');
const NOMINATIM_TIMEOUT_MS = 4_000;
const EARTH_RADIUS_METERS = 6_371_000;
const DUPLICATE_RADIUS_METERS = 150;
const ADDRESSED_PLACE_RADIUS_METERS = 250;
const CAMPUS_DUPLICATE_RADIUS_METERS = 1_000;
const NOMINATIM_TEXT_VIEWBOX_RADIUS = { latitude: 0.35, longitude: 0.5 };

interface SearchResultMetadata {
  exactAlias?: string;
  isEntrance?: boolean;
  location: SearchLocation;
  members?: readonly SearchResult[];
  osmType?: string;
  providerConfidence: number;
  rawCategory?: string;
}

const metadataByResult = new WeakMap<SearchResult, SearchResultMetadata>();

export function isCalgarySearchCoordinate(coordinate: {
  latitude: number;
  longitude: number;
}): boolean {
  return isCoordinateInBounds(coordinate, CALGARY_REGION_BOUNDS);
}

export function isSupportedSearchCoordinate(coordinate: {
  latitude: number;
  longitude: number;
}): boolean {
  return isCoordinateInServiceCoverage(coordinate);
}

export const SEARCH_CATEGORY_TYPES = {
  apparel: new Set(['clothes']),
  art: new Set(['gallery']),
  atm: new Set(['atm']),
  attraction: new Set(['attraction', 'theme_park']),
  bar: new Set(['bar', 'biergarten', 'pub']),
  'beauty-salon': new Set(['beauty', 'hairdresser']),
  'beauty-supply': new Set(['cosmetics', 'perfumery']),
  cafe: new Set(['cafe']),
  'car-dealer': new Set(['car']),
  'car-repair': new Set(['car_repair', 'tyres']),
  'car-wash': new Set(['car_wash']),
  'charging-station': new Set(['charging_station']),
  cinema: new Set(['cinema']),
  convenience: new Set(['convenience']),
  dessert: new Set(['confectionery', 'ice_cream', 'pastry']),
  'dry-cleaning': new Set(['dry_cleaning']),
  electronics: new Set(['computer', 'electronics', 'mobile_phone']),
  fuel: new Set(['fuel']),
  grocery: new Set(['supermarket']),
  gym: new Set(['fitness_centre', 'sports_centre']),
  healthcare: new Set(['clinic', 'hospital']),
  'home-garden': new Set(['doityourself', 'garden_centre', 'hardware']),
  hotel: new Set(['hotel', 'motel']),
  library: new Set(['library']),
  'live-music': new Set(['music_venue']),
  museum: new Set(['museum']),
  nightlife: new Set(['nightclub']),
  park: new Set(['garden', 'nature_reserve', 'park', 'playground', 'recreation_ground']),
  parking: new Set(['parking']),
  pharmacy: new Set(['pharmacy']),
  'post-office': new Set(['post_office']),
  restaurant: new Set(['fast_food', 'food_court', 'restaurant']),
  'shopping-centre': new Set(['mall', 'retail']),
  'sporting-goods': new Set(['sports']),
  takeout: new Set(['fast_food']),
} as const satisfies Record<SearchCategory, ReadonlySet<string>>;
export const NOMINATIM_CATEGORY_QUERIES = {
  apparel: '[apparel]',
  art: '[art]',
  atm: '[atm]',
  attraction: '[attraction]',
  bar: '[bar]',
  'beauty-salon': '[beauty-salon]',
  'beauty-supply': '[beauty-supply]',
  cafe: '[cafe]',
  'car-dealer': '[car-dealer]',
  'car-repair': '[car-repair]',
  'car-wash': '[car-wash]',
  'charging-station': '[charging-station]',
  cinema: '[cinema]',
  convenience: '[convenience]',
  dessert: '[dessert]',
  'dry-cleaning': '[dry-cleaning]',
  electronics: '[electronics]',
  fuel: '[fuel]',
  grocery: '[grocery]',
  gym: '[gym]',
  healthcare: '[healthcare]',
  'home-garden': '[home-garden]',
  hotel: '[hotel]',
  library: '[library]',
  'live-music': '[live-music]',
  museum: '[museum]',
  nightlife: '[nightlife]',
  park: '[park]',
  parking: '[parking]',
  pharmacy: '[pharmacy]',
  'post-office': '[post-office]',
  restaurant: '[restaurant]',
  'shopping-centre': '[shopping-centre]',
  'sporting-goods': '[sporting-goods]',
  takeout: '[takeout]',
} as const satisfies Record<SearchCategory, string>;
const NOMINATIM_CATEGORY_VIEWBOX_RADII = [
  { latitude: 0.012, longitude: 0.015 },
  { latitude: 0.03, longitude: 0.04 },
  { latitude: 0.06, longitude: 0.08 },
] as const;

// Consumer-facing place kinds for provider metadata. Raw tags remain separate so category
// filtering never has to interpret presentation text.
const SEARCH_CATEGORY_LABELS = {
  apparel: 'clothing store',
  art: 'art gallery',
  atm: 'ATM',
  attraction: 'attraction',
  bar: 'bar',
  'beauty-salon': 'beauty salon',
  'beauty-supply': 'beauty supply',
  cafe: 'café',
  'car-dealer': 'car dealer',
  'car-repair': 'auto repair',
  'car-wash': 'car wash',
  'charging-station': 'EV charging',
  cinema: 'cinema',
  convenience: 'convenience store',
  dessert: 'dessert shop',
  'dry-cleaning': 'dry cleaning',
  electronics: 'electronics store',
  fuel: 'gas station',
  grocery: 'grocery store',
  gym: 'gym',
  healthcare: 'healthcare',
  'home-garden': 'home & garden',
  hotel: 'hotel',
  library: 'library',
  'live-music': 'live music',
  museum: 'museum',
  nightlife: 'nightclub',
  park: 'park',
  parking: 'parking',
  pharmacy: 'pharmacy',
  'post-office': 'post office',
  restaurant: 'restaurant',
  'shopping-centre': 'shopping centre',
  'sporting-goods': 'sporting goods',
  takeout: 'takeout',
} as const satisfies Record<SearchCategory, string>;

const CUISINE_PLACE_TYPES: Record<string, true> = {
  restaurant: true,
  fast_food: true,
  cafe: true,
};
// Descriptions accompany raw detail objects through filtering without adding transport fields.
// Weak keys release the metadata when the request results are discarded.
const descriptionsByDetails = new WeakMap<NonNullable<SearchResult['details']>, string>();

const OMITTED_PLACE_CATEGORIES: Record<string, true> = {
  yes: true,
  no: true,
  unknown: true,
  other: true,
  poi: true,
  'point of interest': true,
  point_of_interest: true,
  amenity: true,
  shop: true,
  building: true,
  commercial: true,
  administrative: true,
  house: true,
  residential: true,
  primary: true,
  secondary: true,
  tertiary: true,
  service: true,
  road: true,
};

const RAW_CATEGORY_LABELS: Record<string, string> = {};
for (const category of Object.keys(SEARCH_CATEGORY_TYPES) as SearchCategory[]) {
  for (const tag of SEARCH_CATEGORY_TYPES[category]) {
    RAW_CATEGORY_LABELS[tag] ??= SEARCH_CATEGORY_LABELS[category];
  }
}
RAW_CATEGORY_LABELS.fast_food = 'fast food';
RAW_CATEGORY_LABELS.food_court = 'food court';
RAW_CATEGORY_LABELS.pub = 'pub';
RAW_CATEGORY_LABELS.biergarten = 'beer garden';
RAW_CATEGORY_LABELS.retail = 'retail area';
RAW_CATEGORY_LABELS.wholesale = 'warehouse store';
RAW_CATEGORY_LABELS.university = 'university';
RAW_CATEGORY_LABELS.college = 'college';
RAW_CATEGORY_LABELS.aerodrome = 'airport';
RAW_CATEGORY_LABELS.train_station = 'train station';
RAW_CATEGORY_LABELS.station = 'train station';
RAW_CATEGORY_LABELS.platform = 'transit platform';
RAW_CATEGORY_LABELS.stop = 'transit stop';
RAW_CATEGORY_LABELS.stop_position = 'transit stop';
RAW_CATEGORY_LABELS.bus_stop = 'bus stop';
RAW_CATEGORY_LABELS.alcohol = 'liquor store';

function nominatimPlaceDescription(
  result: z.infer<typeof NominatimResultSchema>,
): string | undefined {
  const osmClass = result.category ?? result.class;
  if (osmClass === 'entrance') return result.type === 'main' ? 'main entrance' : 'entrance';
  if (osmClass === 'highway' && result.type !== 'bus_stop') return undefined;
  if (osmClass === 'boundary') return undefined;
  if (
    ['railway', 'public_transport', 'building'].includes(osmClass ?? '') &&
    ['station', 'train_station', 'stop', 'stop_position', 'platform'].includes(result.type ?? '')
  ) {
    if (result.extratags?.station === 'light_rail' || result.extratags?.light_rail === 'yes') {
      return 'LRT station';
    }
    if (result.extratags?.station === 'subway' || result.extratags?.subway === 'yes') {
      return 'subway station';
    }
  }
  return result.type === undefined
    ? undefined
    : finalizeDetailCategory(result.type, result.extratags?.cuisine);
}

// Use the first explicitly tagged cuisine, never a guess from a business name. Limit it to two
// plain words so combining it with a place kind produces a useful short description.
function normalizedCuisineWord(cuisine: string | undefined): string | undefined {
  if (cuisine === undefined) return undefined;
  const firstValue = (cuisine.split(';')[0] ?? '')
    .trim()
    .toLocaleLowerCase('en-CA')
    .replaceAll('_', ' ');
  return /^[a-z]+( [a-z]+)?$/.test(firstValue) ? firstValue : undefined;
}

function finalizeDetailCategory(rawCategory: string, cuisine?: string): string | undefined {
  const rawTag = rawCategory.trim().toLocaleLowerCase('en-CA');
  if (rawTag === '' || OMITTED_PLACE_CATEGORIES[rawTag] === true) return undefined;
  const words = rawTag.replaceAll(/[_-]+/g, ' ').split(/\s+/).filter(Boolean);
  if (words.length > 3 || !words.every((word) => /^[\p{L}]+$/u.test(word))) return undefined;
  const baseLabel =
    (Object.hasOwn(RAW_CATEGORY_LABELS, rawTag) ? RAW_CATEGORY_LABELS[rawTag] : undefined) ??
    words.join(' ');
  const cuisineWord =
    CUISINE_PLACE_TYPES[rawTag] === true ? normalizedCuisineWord(cuisine) : undefined;
  if (cuisineWord === undefined || cuisineWord === baseLabel) return baseLabel;
  const description = `${cuisineWord} ${baseLabel}`;
  return description.split(/\s+/).length <= 3 ? description : baseLabel;
}

function finalizeResultDetails(result: SearchResult): SearchResult {
  if (result.details?.category === undefined) return result;
  const category =
    descriptionsByDetails.get(result.details) ?? finalizeDetailCategory(result.details.category);
  const details = { ...result.details };
  delete details.category;
  if (category !== undefined) details.category = category;
  const finalized: SearchResult = { ...result };
  if (Object.keys(details).length === 0) delete finalized.details;
  else finalized.details = details;
  metadataByResult.set(finalized, resultMetadata(result));
  return finalized;
}

function nominatimViewbox(
  query: SearchQuery,
  radius: { latitude: number; longitude: number } | undefined = query.category === undefined
    ? undefined
    : NOMINATIM_CATEGORY_VIEWBOX_RADII.at(-1),
): string {
  if (
    radius === undefined ||
    query.latitude === undefined ||
    query.longitude === undefined ||
    !isSupportedSearchCoordinate({ latitude: query.latitude, longitude: query.longitude })
  ) {
    return [
      SERVICE_COVERAGE_BOUNDS.southWest.longitude,
      SERVICE_COVERAGE_BOUNDS.northEast.latitude,
      SERVICE_COVERAGE_BOUNDS.northEast.longitude,
      SERVICE_COVERAGE_BOUNDS.southWest.latitude,
    ].join(',');
  }
  const west = Math.max(
    SERVICE_COVERAGE_BOUNDS.southWest.longitude,
    query.longitude - radius.longitude,
  );
  const north = Math.min(
    SERVICE_COVERAGE_BOUNDS.northEast.latitude,
    query.latitude + radius.latitude,
  );
  const east = Math.min(
    SERVICE_COVERAGE_BOUNDS.northEast.longitude,
    query.longitude + radius.longitude,
  );
  const south = Math.max(
    SERVICE_COVERAGE_BOUNDS.southWest.latitude,
    query.latitude - radius.latitude,
  );
  return [west, north, east, south].map((value) => String(Number(value.toFixed(3)))).join(',');
}

const PhotonFeatureSchema = z.object({
  geometry: z.object({
    coordinates: z.tuple([z.number().min(-180).max(180), z.number().min(-90).max(90)]),
    type: z.literal('Point'),
  }),
  properties: z.looseObject({
    district: z.string().optional(),
    city: z.string().optional(),
    country: z.string().optional(),
    housenumber: z.string().optional(),
    name: z.string().optional(),
    osm_id: z.union([z.number(), z.string()]),
    osm_key: z.string().optional(),
    osm_type: z.string().optional(),
    osm_value: z.string().optional(),
    postcode: z.string().optional(),
    state: z.string().optional(),
    suburb: z.string().optional(),
    street: z.string().optional(),
    type: z.string().optional(),
  }),
  type: z.literal('Feature'),
});

const PhotonResponseSchema = z.object({
  features: z.array(PhotonFeatureSchema),
  type: z.literal('FeatureCollection'),
});

const NominatimResultSchema = z.looseObject({
  address: z.record(z.string(), z.string()).optional(),
  addresstype: z.string().optional(),
  category: z.string().optional(),
  class: z.string().optional(),
  display_name: z.string().min(1),
  extratags: z
    .record(z.string(), z.string())
    .nullish()
    .transform((value) => value ?? undefined),
  importance: z.number().optional(),
  lat: z.coerce.number().min(-90).max(90),
  lon: z.coerce.number().min(-180).max(180),
  name: z.string().optional(),
  osm_id: z.union([z.number(), z.string()]),
  osm_type: z.string().min(1),
  type: z.string().optional(),
});

const NominatimResponseSchema = z.array(NominatimResultSchema);

export interface SearchProvider {
  isReady?(): Promise<boolean>;
  search(query: SearchQuery): Promise<SearchResponse>;
}

export interface PhotonSearchProviderOptions {
  endpoint?: string;
  fetchImplementation?: typeof fetch;
  now?: () => Date;
}

export interface NominatimSearchProviderOptions {
  datasetVersion?: string;
  endpoint?: string;
  fetchImplementation?: typeof fetch;
  now?: () => Date;
}

function categoryFor(
  properties: z.infer<typeof PhotonFeatureSchema>['properties'],
): SearchResult['category'] {
  if (properties.type === 'house' || properties.housenumber !== undefined) {
    return 'address';
  }
  if (properties.type === 'street') {
    return 'street';
  }
  if (['city', 'district', 'locality', 'suburb'].includes(properties.type ?? '')) {
    return 'neighborhood';
  }
  if (['amenity', 'aeroway', 'leisure', 'shop', 'tourism'].includes(properties.osm_key ?? '')) {
    return 'poi';
  }
  return properties.name === undefined ? 'address' : 'landmark';
}

function displayName(properties: z.infer<typeof PhotonFeatureSchema>['properties']): string {
  const name = nonEmptyText(properties.name);
  if (name !== undefined) {
    return name;
  }
  const address = [properties.housenumber, properties.street].filter(Boolean).join(' ');
  return address.length > 0 ? address : 'Unnamed place';
}

function displayLabel(properties: z.infer<typeof PhotonFeatureSchema>['properties']): string {
  const name = displayName(properties);
  const address = [properties.housenumber, properties.street].filter(Boolean).join(' ');
  const locality = [properties.city, properties.state, properties.postcode]
    .filter(Boolean)
    .join(', ');
  const parts = [name];

  if (address.length > 0 && normalizeSearchText(address) !== normalizeSearchText(name)) {
    parts.push(address);
  }
  if (
    locality.length > 0 &&
    !parts.some((part) => normalizeSearchText(part) === normalizeSearchText(locality))
  ) {
    parts.push(locality);
  }
  return parts.join(', ');
}

function normalizePhotonResults(
  payload: z.infer<typeof PhotonResponseSchema>,
  query: SearchQuery,
): SearchResult[] {
  return payload.features
    .filter((feature) =>
      isSupportedSearchCoordinate({
        latitude: feature.geometry.coordinates[1],
        longitude: feature.geometry.coordinates[0],
      }),
    )
    .map((feature, index) => {
      const detailCategory = query.includeDetails
        ? nonEmptyText(feature.properties.osm_value)
        : undefined;
      const normalized: SearchResult = {
        category: categoryFor(feature.properties),
        center: {
          latitude: feature.geometry.coordinates[1],
          longitude: feature.geometry.coordinates[0],
        },
        confidence: Math.max(0.55, 0.92 - index * 0.06),
        ...(detailCategory === undefined ? {} : { details: { category: detailCategory } }),
        id: `photon:${feature.properties.osm_type ?? 'unknown'}:${String(feature.properties.osm_id)}`,
        label: displayLabel(feature.properties),
        name: displayName(feature.properties),
      };
      metadataByResult.set(normalized, {
        location: searchLocation(normalized.name, normalized.label, {
          city: feature.properties.city,
          house_number: feature.properties.housenumber,
          road: feature.properties.street,
          suburb: feature.properties.suburb ?? feature.properties.district,
        }),
        osmType: feature.properties.osm_type,
        providerConfidence: normalized.confidence,
        ...(feature.properties.osm_value === undefined
          ? {}
          : { rawCategory: feature.properties.osm_value }),
      });
      return normalized;
    });
}

function nominatimCategory(
  result: z.infer<typeof NominatimResultSchema>,
): SearchResult['category'] {
  if (
    ['house', 'building'].includes(result.addresstype ?? '') ||
    /^\s*\d/.test(result.name ?? result.display_name)
  ) {
    return 'address';
  }
  if (['road', 'street', 'footway', 'path'].includes(result.addresstype ?? '')) {
    return 'street';
  }
  if (
    ['city', 'borough', 'suburb', 'quarter', 'neighbourhood'].includes(result.addresstype ?? '')
  ) {
    return 'neighborhood';
  }
  if (
    ['amenity', 'shop', 'tourism', 'leisure', 'aeroway', 'railway', 'public_transport'].includes(
      result.category ?? result.class ?? '',
    )
  ) {
    return 'poi';
  }
  return 'landmark';
}

function nonEmptyText(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized === '' ? undefined : normalized;
}

function normalizeNominatimResults(
  payload: z.infer<typeof NominatimResponseSchema>,
  query: SearchQuery,
): SearchResult[] {
  const normalizedQuery = normalizeSearchText(query.q);
  return payload
    .filter((result) =>
      isSupportedSearchCoordinate({
        latitude: result.lat,
        longitude: result.lon,
      }),
    )
    .map((result) => {
      const sourceName = nonEmptyText(result.name);
      const displayName = nonEmptyText(result.display_name.split(',')[0]);
      const name = sourceName ?? displayName ?? 'Unnamed place';
      const normalizedName = normalizeSearchText(name);
      const normalizedLabel = normalizeSearchText(result.display_name);
      const words = normalizedQuery.split(' ').filter(Boolean);
      let confidence = 0.55;

      if (normalizedName === normalizedQuery || normalizedLabel === normalizedQuery) {
        confidence = 0.98;
      } else if (normalizedName.startsWith(normalizedQuery)) {
        confidence = 0.94;
      } else if (normalizedLabel.startsWith(normalizedQuery)) {
        confidence = 0.92;
      } else if (normalizedName.includes(normalizedQuery)) {
        confidence = 0.86;
      } else if (words.every((word) => normalizedLabel.includes(word))) {
        confidence = 0.8;
      }

      const openingHours = nonEmptyText(result.extratags?.opening_hours);
      const phone = nonEmptyText(result.extratags?.phone ?? result.extratags?.['contact:phone']);
      const website = nonEmptyText(
        result.extratags?.website ?? result.extratags?.['contact:website'],
      );
      const wheelchair = nonEmptyText(result.extratags?.wheelchair);
      const placeDescription = nominatimPlaceDescription(result);

      const normalized: SearchResult = {
        category: nominatimCategory(result),
        center: { latitude: result.lat, longitude: result.lon },
        confidence,
        ...(query.includeDetails
          ? {
              details: {
                address: result.display_name,
                ...(result.type === undefined ? {} : { category: result.type }),
                ...(openingHours ? { openingHours } : {}),
                ...(phone ? { phone } : {}),
                ...(website ? { website } : {}),
                ...(wheelchair ? { wheelchair } : {}),
              },
            }
          : {}),
        id: `nominatim:${result.osm_type}:${String(result.osm_id)}`,
        label: result.display_name,
        name,
      };
      metadataByResult.set(normalized, {
        isEntrance:
          (result.extratags?.entrance === 'main' ||
            ((result.category ?? result.class) === 'entrance' && result.type === 'main')) &&
          !['no', 'private'].includes(result.extratags?.access ?? '') &&
          !['no', 'private'].includes(
            result.extratags?.motor_vehicle ?? result.extratags?.vehicle ?? '',
          ),
        location: searchLocation(name, result.display_name, result.address),
        osmType: result.osm_type,
        providerConfidence: confidence,
        ...(result.type === undefined ? {} : { rawCategory: result.type }),
      });
      if (
        query.includeDetails &&
        placeDescription !== undefined &&
        normalized.details !== undefined
      ) {
        descriptionsByDetails.set(normalized.details, placeDescription);
      }
      return normalized;
    });
}

export function buildPhotonSearchUrl(query: SearchQuery, endpoint = DEFAULT_PHOTON_URL): string {
  const url = new URL(endpoint);
  url.searchParams.set('bbox', SEARCH_BOUNDS);
  url.searchParams.set('lang', 'en');
  url.searchParams.set('limit', String(query.limit));
  url.searchParams.set('q', query.q);
  if (query.latitude !== undefined && query.longitude !== undefined) {
    url.searchParams.set('lat', String(query.latitude));
    url.searchParams.set('lon', String(query.longitude));
  }
  return url.toString();
}

export function buildNominatimSearchUrl(
  query: SearchQuery,
  endpoint: string,
  categoryRadius?: { latitude: number; longitude: number },
): string {
  const url = new URL('search', endpoint.endsWith('/') ? endpoint : `${endpoint}/`);
  url.searchParams.set('accept-language', 'en-CA,en');
  url.searchParams.set('addressdetails', '1');
  url.searchParams.set('bounded', '1');
  url.searchParams.set('extratags', '1');
  url.searchParams.set('format', 'jsonv2');
  url.searchParams.set('limit', String(query.limit));
  url.searchParams.set(
    'q',
    query.category === undefined ? query.q : NOMINATIM_CATEGORY_QUERIES[query.category],
  );
  url.searchParams.set('viewbox', nominatimViewbox(query, categoryRadius));
  return url.toString();
}

export function createFixtureSearchProvider(
  fixtures: readonly SearchFixture[] = CALGARY_SEARCH_FIXTURES,
): SearchProvider {
  return {
    search(query) {
      const response = searchFixtures(fixtures, query);
      for (const result of response.results) {
        if (
          result.confidence === 1 &&
          normalizeSearchText(result.name) !== normalizeSearchText(query.q)
        ) {
          const metadata = resultMetadata(result);
          metadata.exactAlias = normalizeSearchText(query.q);
        }
      }
      return Promise.resolve({
        ...response,
        results: mergeResults([response.results], query, query.limit).map(finalizeResultDetails),
      });
    },
  };
}

export function createPhotonSearchProvider(
  options: PhotonSearchProviderOptions = {},
): SearchProvider {
  const endpoint = options.endpoint ?? process.env.PHOTON_URL ?? DEFAULT_PHOTON_URL;
  const fetchImplementation = options.fetchImplementation ?? fetch;
  const now = options.now ?? (() => new Date());

  return {
    async search(query) {
      const response = await fetchImplementation(buildPhotonSearchUrl(query, endpoint), {
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(PHOTON_TIMEOUT_MS),
      });
      if (!response.ok) {
        throw new Error(`Photon returned status ${String(response.status)}.`);
      }
      const parsed = PhotonResponseSchema.parse(await response.json());
      return {
        degraded: true,
        results: mergeResults([normalizePhotonResults(parsed, query)], query, query.limit),
        source: {
          datasetVersion: 'openstreetmap-continuous',
          freshness: 'fresh',
          id: 'photon-development',
          updatedAt: now().toISOString(),
        },
      };
    },
  };
}

export function createNominatimSearchProvider(
  options: NominatimSearchProviderOptions,
): SearchProvider {
  const endpoint = options.endpoint ?? process.env.NOMINATIM_URL;
  if (endpoint === undefined) {
    throw new Error('NOMINATIM_URL is required for production search.');
  }
  const datasetVersion =
    options.datasetVersion ??
    process.env.NOMINATIM_DATASET_VERSION ??
    'alberta-british-columbia-geofabrik';
  const fetchImplementation = options.fetchImplementation ?? fetch;
  const now = options.now ?? (() => new Date());

  return {
    async isReady() {
      try {
        const statusUrl = new URL('status', endpoint.endsWith('/') ? endpoint : `${endpoint}/`);
        const response = await fetchImplementation(statusUrl, {
          headers: { accept: 'text/plain', 'user-agent': 'NavOSS/0.1' },
          signal: AbortSignal.timeout(NOMINATIM_TIMEOUT_MS),
        });
        return response.ok;
      } catch {
        return false;
      }
    },
    async search(query) {
      const categoryRadii =
        query.latitude !== undefined &&
        query.longitude !== undefined &&
        isSupportedSearchCoordinate({ latitude: query.latitude, longitude: query.longitude })
          ? query.category === undefined
            ? [NOMINATIM_TEXT_VIEWBOX_RADIUS, undefined]
            : NOMINATIM_CATEGORY_VIEWBOX_RADII
          : [undefined];
      const urls = [
        ...new Set(categoryRadii.map((radius) => buildNominatimSearchUrl(query, endpoint, radius))),
      ];
      // Local and provincial pools start together and share one timeout budget.
      const signal = AbortSignal.timeout(NOMINATIM_TIMEOUT_MS);
      const settled = await Promise.allSettled(
        urls.map(async (url) => {
          const response = await fetchImplementation(url, {
            headers: { accept: 'application/json', 'user-agent': 'NavOSS/0.1' },
            signal,
          });
          if (!response.ok) {
            throw new Error(`Nominatim returned status ${String(response.status)}.`);
          }
          return normalizeNominatimResults(
            NominatimResponseSchema.parse(await response.json()),
            query,
          );
        }),
      );
      const resultGroups = settled
        .filter(
          (result): result is PromiseFulfilledResult<SearchResult[]> =>
            result.status === 'fulfilled',
        )
        .map((result) => result.value);
      if (resultGroups.length === 0) {
        const failed = settled.find((result) => result.status === 'rejected');
        throw failed?.reason ?? new Error('Nominatim search returned no successful response.');
      }
      return {
        degraded: settled.some((result) => result.status === 'rejected'),
        results: mergeResults(resultGroups, query, query.limit),
        source: {
          datasetVersion,
          freshness: 'fresh',
          id: 'nominatim-self-hosted',
          updatedAt: now().toISOString(),
        },
      };
    },
  };
}

function coordinateDistanceMeters(
  left: { latitude: number; longitude: number },
  right: { latitude: number; longitude: number },
): number {
  const toRadians = (degrees: number) => (degrees * Math.PI) / 180;
  const latitudeDelta = toRadians(right.latitude - left.latitude);
  const longitudeDelta = toRadians(right.longitude - left.longitude);
  const haversine =
    Math.sin(latitudeDelta / 2) ** 2 +
    Math.cos(toRadians(left.latitude)) *
      Math.cos(toRadians(right.latitude)) *
      Math.sin(longitudeDelta / 2) ** 2;
  return 2 * EARTH_RADIUS_METERS * Math.asin(Math.sqrt(haversine));
}

function resultMetadata(result: SearchResult): SearchResultMetadata {
  let metadata = metadataByResult.get(result);
  if (metadata === undefined) {
    metadata = {
      location: searchLocation(result.name, result.label),
      osmType: result.id.split(':')[1],
      providerConfidence: result.confidence,
      ...(result.details?.category === undefined ? {} : { rawCategory: result.details.category }),
    };
    metadataByResult.set(result, metadata);
  }
  return metadata;
}

function presentSearchResult(result: SearchResult, query: SearchQuery): SearchResult {
  const metadata = resultMetadata(result);
  const name = result.name.replace(/\s+#\d{2,}\s*$/u, '').trim();
  const label = metadata.location.subtitle === '' ? name : `${name}, ${metadata.location.subtitle}`;
  const presented: SearchResult = {
    ...result,
    confidence:
      query.category !== undefined
        ? result.confidence
        : metadata.exactAlias === normalizeSearchText(query.q)
          ? 1
          : searchNameConfidence(name, label, query.q, metadata.providerConfidence),
    ...(query.latitude === undefined || query.longitude === undefined
      ? {}
      : {
          distanceMeters: Math.round(
            coordinateDistanceMeters(
              { latitude: query.latitude, longitude: query.longitude },
              result.center,
            ),
          ),
        }),
    label,
    name,
  };
  metadataByResult.set(presented, metadata);
  return presented;
}

function placeKind(result: SearchResult): string | undefined {
  const metadata = resultMetadata(result);
  const category = metadata.rawCategory?.toLocaleLowerCase('en-CA');
  if (metadata.isEntrance === true && ['entrance', 'main', 'yes'].includes(category ?? ''))
    return undefined;
  if (category === undefined || OMITTED_PLACE_CATEGORIES[category] === true) return undefined;
  if (
    [
      'station',
      'train_station',
      'stop',
      'stop_position',
      'platform',
      'train station',
      'transit stop',
      'transit platform',
      'lrt station',
    ].includes(category)
  )
    return 'rail-station';
  if (category === 'wholesale' || category === 'warehouse store') return 'wholesale';
  if (category === 'cafe' || category === 'café') return 'cafe';
  return category;
}

function representativeQuality(result: SearchResult): number {
  const metadata = resultMetadata(result);
  const rawCategory = metadata.rawCategory?.toLocaleLowerCase('en-CA');
  const kind = placeKind(result);
  const completeStation =
    kind === 'rail-station' &&
    ['station', 'train_station', 'train station', 'lrt station'].includes(rawCategory ?? '');
  const geometry =
    result.id.startsWith('poi:') || result.id.startsWith('landmark:')
      ? 4 // Curated fixtures are established routing points, not derived polygon centroids.
      : ['way', 'relation', 'W', 'R'].includes(metadata.osmType ?? '')
        ? 3
        : 2;
  return (
    (metadata.isEntrance === true ? 10_000 : 0) +
    (completeStation ? 3_000 : kind === undefined ? 0 : 2_000) +
    (metadata.location.houseNumber === undefined ? 0 : 200) +
    (metadata.location.street === undefined ? 0 : 100) +
    geometry * 10 +
    metadata.providerConfidence
  );
}

function samePlace(left: SearchResult, right: SearchResult): boolean {
  if (left.id === right.id) return true;
  const leftMetadata = resultMetadata(left);
  const rightMetadata = resultMetadata(right);
  const leftLocation = leftMetadata.location;
  const rightLocation = rightMetadata.location;
  const leftKind = placeKind(left);
  const rightKind = placeKind(right);
  const sameAddress =
    leftLocation.houseNumber !== undefined &&
    rightLocation.houseNumber !== undefined &&
    normalizeSearchText(leftLocation.houseNumber) ===
      normalizeSearchText(rightLocation.houseNumber) &&
    leftLocation.street !== undefined &&
    rightLocation.street !== undefined &&
    normalizeSearchText(leftLocation.street) === normalizeSearchText(rightLocation.street);
  const leftName = canonicalSearchName(left.name);
  const rightName = canonicalSearchName(right.name);
  const cityVariant =
    sameAddress &&
    (left.id.startsWith('poi:') ||
      left.id.startsWith('landmark:') ||
      right.id.startsWith('poi:') ||
      right.id.startsWith('landmark:')) &&
    ((leftLocation.city !== undefined &&
      leftName === `${normalizeSearchText(leftLocation.city)} ${rightName}`) ||
      (rightLocation.city !== undefined &&
        rightName === `${normalizeSearchText(rightLocation.city)} ${leftName}`));
  const stationVariant =
    leftKind === 'rail-station' &&
    rightKind === 'rail-station' &&
    leftName.replace(/ (?:lrt |train |railway )?station$/u, '') ===
      rightName.replace(/ (?:lrt |train |railway )?station$/u, '');
  const entranceVariant =
    (leftMetadata.isEntrance === true &&
      leftName.replace(/ (?:main )?entrance$/u, '') === rightName) ||
    (rightMetadata.isEntrance === true &&
      rightName.replace(/ (?:main )?entrance$/u, '') === leftName);
  if (leftName !== rightName && !cityVariant && !stationVariant && !entranceVariant) return false;
  if (
    leftLocation.houseNumber !== undefined &&
    rightLocation.houseNumber !== undefined &&
    normalizeSearchText(leftLocation.houseNumber) !== normalizeSearchText(rightLocation.houseNumber)
  )
    return false;
  if (
    leftLocation.unit !== undefined &&
    rightLocation.unit !== undefined &&
    normalizeSearchText(leftLocation.unit) !== normalizeSearchText(rightLocation.unit)
  )
    return false;
  if (leftKind !== undefined && rightKind !== undefined && leftKind !== rightKind) return false;
  if (
    !sameAddress &&
    !(leftKind === 'rail-station' && rightKind === 'rail-station') &&
    (leftLocation.houseNumber === undefined || rightLocation.houseNumber === undefined) &&
    leftLocation.street !== undefined &&
    rightLocation.street !== undefined &&
    normalizeSearchText(leftLocation.street) !== normalizeSearchText(rightLocation.street)
  )
    return false;
  // Only a tagged campus may bridge its large node/way/boundary coordinate spread. Different
  // civic addresses still veto merging, and all members must be mutually within this radius.
  const campus =
    (leftKind === 'university' &&
      (rightKind === 'university' || rightMetadata.rawCategory === 'administrative')) ||
    (rightKind === 'university' &&
      (leftKind === 'university' || leftMetadata.rawCategory === 'administrative'));
  const sameSource = left.id.split(':', 1)[0] === right.id.split(':', 1)[0];
  if (
    !campus &&
    leftKind !== 'rail-station' &&
    rightKind !== 'rail-station' &&
    leftMetadata.isEntrance !== true &&
    rightMetadata.isEntrance !== true &&
    sameSource &&
    (leftMetadata.osmType === rightMetadata.osmType ||
      (left.id.startsWith('calgary-business:') && !sameAddress))
  )
    return false;
  const radius = campus
    ? CAMPUS_DUPLICATE_RADIUS_METERS
    : sameAddress
      ? ADDRESSED_PLACE_RADIUS_METERS
      : DUPLICATE_RADIUS_METERS;
  return coordinateDistanceMeters(left.center, right.center) <= radius;
}

function mergeResults(
  resultGroups: SearchResult[][],
  query: SearchQuery,
  limit: number,
): SearchResult[] {
  const clusters: { members: SearchResult[]; result: SearchResult }[] = [];
  for (const result of resultGroups.flat()) {
    if (!isSupportedSearchCoordinate(result.center)) continue;
    const members = resultMetadata(result).members ?? [result];
    const cluster = clusters.find((existing) =>
      existing.members.every((left) => members.every((right) => samePlace(left, right))),
    );
    if (cluster === undefined) {
      clusters.push({ members: [...members], result });
      continue;
    }
    const existing = cluster.result;
    const preferred =
      representativeQuality(result) > representativeQuality(existing) ? result : existing;
    const other = preferred === result ? existing : result;
    const details = { ...other.details, ...preferred.details };
    if (
      other.details?.address !== undefined &&
      (preferred.details?.address === undefined ||
        searchLocation(preferred.name, preferred.details.address).streetAddress === undefined)
    ) {
      details.address = other.details.address;
    }
    const description =
      (preferred.details === undefined
        ? undefined
        : descriptionsByDetails.get(preferred.details)) ??
      (other.details === undefined ? undefined : descriptionsByDetails.get(other.details));
    if (description !== undefined) descriptionsByDetails.set(details, description);
    const metadata = { ...resultMetadata(preferred) };
    const auxiliaryEntrance = metadata.isEntrance === true && placeKind(preferred) === undefined;
    if (auxiliaryEntrance && other.details?.category !== undefined) {
      details.category = other.details.category;
      const categoryDescription = descriptionsByDetails.get(other.details);
      if (categoryDescription === undefined) descriptionsByDetails.delete(details);
      else descriptionsByDetails.set(details, categoryDescription);
    }
    const otherMetadata = resultMetadata(other);
    // A missing kind on another snapshot of the very same ID is not a second place.
    if (preferred.id === other.id) otherMetadata.rawCategory ??= metadata.rawCategory;
    metadata.exactAlias ??= otherMetadata.exactAlias;
    if (metadata.location.street === undefined && otherMetadata.location.street !== undefined) {
      metadata.location = otherMetadata.location;
    } else if (metadata.location.city === undefined && otherMetadata.location.city !== undefined) {
      const city = otherMetadata.location.city;
      metadata.location = {
        ...metadata.location,
        city,
        subtitle: [metadata.location.subtitle, city].filter(Boolean).join(', '),
      };
    }
    if (auxiliaryEntrance) metadata.rawCategory = otherMetadata.rawCategory;
    else metadata.rawCategory ??= otherMetadata.rawCategory;
    const merged: SearchResult = {
      ...preferred,
      ...(auxiliaryEntrance ? { name: other.name } : {}),
      ...(Object.keys(details).length === 0 ? {} : { details }),
    };
    metadataByResult.set(merged, metadata);
    cluster.members.push(...members);
    metadata.members = cluster.members;
    cluster.result = merged;
  }
  const ranked = clusters.map(({ members, result }) => {
    resultMetadata(result).members = members;
    return presentSearchResult(result, query);
  });
  const counts = new Map<string, number>();
  for (const result of ranked) {
    const name = canonicalSearchName(result.name);
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  const wanted = canonicalSearchName(query.q);
  const brandQuery = (counts.get(wanted) ?? 0) > 1;
  if (brandQuery && query.category === undefined) {
    // For a brand, exact and prefix matches share a tier: the nearest branch/department wins,
    // not the source spelling or a warehouse hundreds of kilometres away.
    for (const result of ranked) {
      if (result.confidence === 0.98 || result.confidence === 0.94) result.confidence = 0.94;
    }
  }
  return ranked
    .sort((left, right) => {
      const distanceDelta =
        (left.distanceMeters ?? Number.POSITIVE_INFINITY) -
        (right.distanceMeters ?? Number.POSITIVE_INFINITY);
      const confidenceDelta = right.confidence - left.confidence;
      return (
        (query.sort === 'distance' || query.category !== undefined
          ? distanceDelta || confidenceDelta
          : confidenceDelta || distanceDelta) ||
        left.label.localeCompare(right.label, 'en-CA') ||
        left.id.localeCompare(right.id, 'en-CA')
      );
    })
    .slice(0, limit);
}

function matchesSearchCategory(result: SearchResult, query: SearchQuery): boolean {
  if (query.category === undefined) return true;
  const category = result.details?.category?.toLocaleLowerCase('en-CA');
  if (category === undefined) return false;
  return SEARCH_CATEGORY_TYPES[query.category].has(category);
}

function combinedSource(responses: SearchResponse[]): SearchResponse['source'] {
  const firstResponse = responses.at(0);
  if (
    firstResponse !== undefined &&
    responses.every(
      (response) =>
        response.source.id === firstResponse.source.id &&
        response.source.datasetVersion === firstResponse.source.datasetVersion,
    )
  ) {
    return firstResponse.source;
  }
  return {
    datasetVersion: responses
      .map((response) => `${response.source.id}:${response.source.datasetVersion}`)
      .join('+'),
    freshness: responses.some((response) => response.source.freshness === 'stale')
      ? 'stale'
      : responses.every((response) => response.source.freshness === 'static')
        ? 'static'
        : 'fresh',
    id: 'calgary-hybrid-search',
    updatedAt: new Date(
      Math.min(...responses.map((response) => Date.parse(response.source.updatedAt))),
    ).toISOString(),
  };
}

export function createDevelopmentSearchProvider(
  fixtures: readonly SearchFixture[] = CALGARY_SEARCH_FIXTURES,
  photonProvider: SearchProvider = createPhotonSearchProvider(),
): SearchProvider {
  const fixtureProvider = createFixtureSearchProvider(fixtures);
  return {
    async search(query) {
      const useCalgarySources =
        query.latitude === undefined ||
        query.longitude === undefined ||
        isCalgarySearchCoordinate({ latitude: query.latitude, longitude: query.longitude });
      const fixtureResponse = useCalgarySources
        ? await fixtureProvider.search(query)
        : {
            degraded: true,
            results: [],
            source: {
              datasetVersion: 'not-applicable',
              freshness: 'static' as const,
              id: 'regional-empty-fixtures',
              updatedAt: new Date(0).toISOString(),
            },
          };
      try {
        const photonResponse = await photonProvider.search({
          ...query,
          includeDetails: query.includeDetails === true || query.category !== undefined,
          limit: Math.min(20, query.limit * 2),
        });
        return {
          degraded: true,
          results: mergeResults(
            [fixtureResponse.results, photonResponse.results].map((results) =>
              results.filter((result) => matchesSearchCategory(result, query)),
            ),
            query,
            query.limit,
          ).map(finalizeResultDetails),
          source: photonResponse.source,
        };
      } catch {
        return fixtureResponse;
      }
    },
  };
}

export function createProductionSearchProvider(
  fixtures: readonly SearchFixture[] = CALGARY_SEARCH_FIXTURES,
  productionProvider: SearchProvider = createNominatimSearchProvider({}),
  calgaryProvider: SearchProvider | undefined = process.env.SEARCH_DATABASE_ENABLED !== '1'
    ? undefined
    : createPostgresCalgarySearchProvider(),
): SearchProvider {
  const fixtureProvider = createFixtureSearchProvider(fixtures);
  return {
    async isReady() {
      const providers = [
        productionProvider,
        ...(calgaryProvider === undefined ? [] : [calgaryProvider]),
      ];
      const readiness = await Promise.all(
        providers.map((provider) => provider.isReady?.() ?? Promise.resolve(true)),
      );
      return readiness.every(Boolean);
    },
    async search(query) {
      const useCalgarySources =
        query.latitude === undefined ||
        query.longitude === undefined ||
        isCalgarySearchCoordinate({ latitude: query.latitude, longitude: query.longitude });
      const fixtureResponse = useCalgarySources
        ? await fixtureProvider.search(query)
        : {
            degraded: true,
            results: [],
            source: {
              datasetVersion: 'not-applicable',
              freshness: 'static' as const,
              id: 'regional-empty-fixtures',
              updatedAt: new Date(0).toISOString(),
            },
          };
      const providerQuery = {
        ...query,
        includeDetails: query.includeDetails === true || query.category !== undefined,
        limit: Math.min(20, query.limit * 2),
      };
      const providerQueryWithoutCategory = { ...providerQuery };
      delete providerQueryWithoutCategory.category;
      const productionQueries: SearchQuery[] = [
        ...(query.category === undefined
          ? placeSearchQueryVariants(query.q).map((q) => ({ ...providerQuery, q }))
          : [providerQuery]),
        ...(query.category === 'grocery' && useCalgarySources
          ? ['Safeway', 'Sobeys', 'Calgary Co-op'].map((q) => ({
              ...providerQueryWithoutCategory,
              q,
            }))
          : []),
      ];
      const settled = await Promise.allSettled([
        ...productionQueries.map((productionQuery) => productionProvider.search(productionQuery)),
        ...(calgaryProvider === undefined || query.category !== undefined || !useCalgarySources
          ? []
          : [calgaryProvider.search(providerQuery)]),
      ]);
      const responses = settled
        .filter(
          (result): result is PromiseFulfilledResult<SearchResponse> =>
            result.status === 'fulfilled',
        )
        .map((result) => result.value);
      if (responses.length === 0) {
        return fixtureResponse;
      }
      return {
        degraded:
          settled.some((result) => result.status === 'rejected') ||
          responses.some((response) => response.degraded),
        results: mergeResults(
          [fixtureResponse.results, ...responses.map((response) => response.results)].map(
            (results) => results.filter((result) => matchesSearchCategory(result, query)),
          ),
          query,
          query.limit,
        ).map(finalizeResultDetails),
        source:
          useCalgarySources || responses[0] === undefined
            ? combinedSource(responses)
            : responses[0].source,
      };
    },
  };
}
