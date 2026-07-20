import type { SearchQuery, SearchResponse, SearchResult } from '@navoss/contracts';
import { z } from 'zod/v4';

import { CALGARY_SEARCH_FIXTURES, type SearchFixture } from './fixtures.js';
import { searchFixtures } from './search.js';

const DEFAULT_PHOTON_URL = 'https://photon.komoot.io/api/';
const PHOTON_TIMEOUT_MS = 3_000;
const CALGARY_BOUNDS = '-114.316,50.842,-113.859,51.212';
const NOMINATIM_TIMEOUT_MS = 4_000;

const PhotonFeatureSchema = z.object({
  geometry: z.object({
    coordinates: z.tuple([z.number().min(-180).max(180), z.number().min(-90).max(90)]),
    type: z.literal('Point'),
  }),
  properties: z.looseObject({
    city: z.string().optional(),
    country: z.string().optional(),
    housenumber: z.string().optional(),
    name: z.string().optional(),
    osm_id: z.union([z.number(), z.string()]),
    osm_key: z.string().optional(),
    osm_type: z.string().optional(),
    postcode: z.string().optional(),
    state: z.string().optional(),
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
  addresstype: z.string().optional(),
  category: z.string().optional(),
  display_name: z.string().min(1),
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

function normalize(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/\p{Diacritic}/gu, '')
    .toLocaleLowerCase('en-CA')
    .replace(/[^\p{Letter}\p{Number}]+/gu, ' ')
    .trim();
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
  if (properties.name !== undefined) {
    return properties.name;
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

  if (address.length > 0 && normalize(address) !== normalize(name)) {
    parts.push(address);
  }
  if (locality.length > 0 && !parts.some((part) => normalize(part) === normalize(locality))) {
    parts.push(locality);
  }

  return parts.join(', ');
}

function normalizePhotonResults(
  payload: z.infer<typeof PhotonResponseSchema>,
  limit: number,
): SearchResult[] {
  return payload.features.slice(0, limit).map((feature, index) => ({
    category: categoryFor(feature.properties),
    center: {
      latitude: feature.geometry.coordinates[1],
      longitude: feature.geometry.coordinates[0],
    },
    confidence: Math.max(0.55, 0.92 - index * 0.06),
    id: `photon:${feature.properties.osm_type ?? 'unknown'}:${String(feature.properties.osm_id)}`,
    label: displayLabel(feature.properties),
    name: displayName(feature.properties),
  }));
}

function nominatimCategory(
  result: z.infer<typeof NominatimResultSchema>,
): SearchResult['category'] {
  if (['house', 'building'].includes(result.addresstype ?? '')) {
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
  if (['amenity', 'shop', 'tourism', 'leisure', 'aeroway'].includes(result.category ?? '')) {
    return 'poi';
  }
  return 'landmark';
}

function normalizeNominatimResults(
  payload: z.infer<typeof NominatimResponseSchema>,
  limit: number,
): SearchResult[] {
  return payload.slice(0, limit).map((result, index) => ({
    category: nominatimCategory(result),
    center: { latitude: result.lat, longitude: result.lon },
    confidence: Math.max(0.55, Math.min(0.95, result.importance ?? 0.9 - index * 0.06)),
    id: `nominatim:${result.osm_type}:${String(result.osm_id)}`,
    label: result.display_name,
    name: result.name ?? result.display_name.split(',')[0]?.trim() ?? 'Unnamed place',
  }));
}

export function buildPhotonSearchUrl(query: SearchQuery, endpoint = DEFAULT_PHOTON_URL): string {
  const url = new URL(endpoint);
  url.searchParams.set('bbox', CALGARY_BOUNDS);
  url.searchParams.set('lang', 'en');
  url.searchParams.set('limit', String(query.limit));
  url.searchParams.set('q', query.q);

  if (query.latitude !== undefined && query.longitude !== undefined) {
    url.searchParams.set('lat', String(query.latitude));
    url.searchParams.set('lon', String(query.longitude));
  }

  return url.toString();
}

export function buildNominatimSearchUrl(query: SearchQuery, endpoint: string): string {
  const url = new URL('search', endpoint.endsWith('/') ? endpoint : `${endpoint}/`);
  url.searchParams.set('accept-language', 'en-CA,en');
  url.searchParams.set('addressdetails', '1');
  url.searchParams.set('bounded', '1');
  url.searchParams.set('format', 'jsonv2');
  url.searchParams.set('limit', String(query.limit));
  url.searchParams.set('q', query.q);
  url.searchParams.set('viewbox', '-114.316,51.212,-113.859,50.842');
  return url.toString();
}

export function createFixtureSearchProvider(
  fixtures: readonly SearchFixture[] = CALGARY_SEARCH_FIXTURES,
): SearchProvider {
  return {
    search: (query) => Promise.resolve(searchFixtures(fixtures, query)),
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

      const payload: unknown = await response.json();
      const parsed = PhotonResponseSchema.parse(payload);
      return {
        degraded: true,
        results: normalizePhotonResults(parsed, query.limit),
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
    options.datasetVersion ?? process.env.NOMINATIM_DATASET_VERSION ?? 'alberta-geofabrik';
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
      const response = await fetchImplementation(buildNominatimSearchUrl(query, endpoint), {
        headers: { accept: 'application/json', 'user-agent': 'NavOSS/0.1' },
        signal: AbortSignal.timeout(NOMINATIM_TIMEOUT_MS),
      });
      if (!response.ok) {
        throw new Error(`Nominatim returned status ${String(response.status)}.`);
      }

      const payload: unknown = await response.json();
      const parsed = NominatimResponseSchema.parse(payload);
      return {
        degraded: false,
        results: normalizeNominatimResults(parsed, query.limit),
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

function mergeResults(
  fixtureResults: SearchResult[],
  photonResults: SearchResult[],
  limit: number,
): SearchResult[] {
  const seenNames = new Set<string>();
  return [...fixtureResults, ...photonResults]
    .filter((result) => {
      const key = normalize(result.name);
      if (seenNames.has(key)) {
        return false;
      }
      seenNames.add(key);
      return true;
    })
    .slice(0, limit);
}

export function createDevelopmentSearchProvider(
  fixtures: readonly SearchFixture[] = CALGARY_SEARCH_FIXTURES,
  photonProvider: SearchProvider = createPhotonSearchProvider(),
): SearchProvider {
  const fixtureProvider = createFixtureSearchProvider(fixtures);

  return {
    async search(query) {
      const fixtureResponse = await fixtureProvider.search(query);

      try {
        const photonResponse = await photonProvider.search(query);
        return {
          degraded: true,
          results: mergeResults(fixtureResponse.results, photonResponse.results, query.limit),
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
): SearchProvider {
  const fixtureProvider = createFixtureSearchProvider(fixtures);

  return {
    isReady: () => productionProvider.isReady?.() ?? Promise.resolve(false),
    async search(query) {
      const fixtureResponse = await fixtureProvider.search(query);

      try {
        const productionResponse = await productionProvider.search(query);
        return {
          ...productionResponse,
          results: mergeResults(fixtureResponse.results, productionResponse.results, query.limit),
        };
      } catch {
        return fixtureResponse;
      }
    },
  };
}
