import type { SearchQuery, SearchResponse, SearchResult } from '@navoss/contracts';
import { z } from 'zod/v4';

import { createPostgresCalgarySearchProvider } from './calgary-search-provider.js';
import { CALGARY_SEARCH_FIXTURES, type SearchFixture } from './fixtures.js';
import { searchFixtures } from './search.js';
import { normalizeSearchText } from './search-text.js';

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
  extratags: z.record(z.string(), z.string()).optional(),
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
  if (['amenity', 'shop', 'tourism', 'leisure', 'aeroway'].includes(result.category ?? '')) {
    return 'poi';
  }
  return 'landmark';
}

function normalizeNominatimResults(
  payload: z.infer<typeof NominatimResponseSchema>,
  query: SearchQuery,
): SearchResult[] {
  const normalizedQuery = normalizeSearchText(query.q);
  return payload.slice(0, query.limit).map((result) => {
    const name = result.name ?? result.display_name.split(',')[0]?.trim() ?? 'Unnamed place';
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

    return {
      category: nominatimCategory(result),
      center: { latitude: result.lat, longitude: result.lon },
      confidence,
      ...(query.includeDetails
        ? {
            details: {
              address: result.display_name,
              ...(result.type === undefined ? {} : { category: result.type }),
              ...(result.extratags?.opening_hours === undefined
                ? {}
                : { openingHours: result.extratags.opening_hours }),
              ...((result.extratags?.phone ?? result.extratags?.['contact:phone']) === undefined
                ? {}
                : { phone: result.extratags?.phone ?? result.extratags?.['contact:phone'] }),
              ...((result.extratags?.website ?? result.extratags?.['contact:website']) === undefined
                ? {}
                : { website: result.extratags?.website ?? result.extratags?.['contact:website'] }),
              ...(result.extratags?.wheelchair === undefined
                ? {}
                : { wheelchair: result.extratags.wheelchair }),
            },
          }
        : {}),
      id: `nominatim:${result.osm_type}:${String(result.osm_id)}`,
      label: result.display_name,
      name,
    };
  });
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
  url.searchParams.set('extratags', '1');
  url.searchParams.set('format', 'jsonv2');
  url.searchParams.set('limit', String(query.limit));
  url.searchParams.set('q', query.q);
  url.searchParams.set('viewbox', '-114.316,51.212,-113.859,50.842');
  return url.toString();
}

export function createFixtureSearchProvider(
  fixtures: readonly SearchFixture[] = CALGARY_SEARCH_FIXTURES,
): SearchProvider {
  return { search: (query) => Promise.resolve(searchFixtures(fixtures, query)) };
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
      const parsed = NominatimResponseSchema.parse(await response.json());
      return {
        degraded: false,
        results: normalizeNominatimResults(parsed, query),
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

function resultDistance(result: SearchResult, query: SearchQuery): number {
  if (query.latitude === undefined || query.longitude === undefined) {
    return 0;
  }
  return (
    (result.center.latitude - query.latitude) ** 2 +
    (result.center.longitude - query.longitude) ** 2
  );
}

function samePlace(left: SearchResult, right: SearchResult): boolean {
  return (
    left.id.split(':', 1)[0] !== right.id.split(':', 1)[0] &&
    normalizeSearchText(left.name) === normalizeSearchText(right.name) &&
    Math.abs(left.center.latitude - right.center.latitude) < 0.0003 &&
    Math.abs(left.center.longitude - right.center.longitude) < 0.0004
  );
}

function mergeResults(
  resultGroups: SearchResult[][],
  query: SearchQuery,
  limit: number,
): SearchResult[] {
  const ranked = resultGroups
    .flat()
    .sort(
      (left, right) =>
        right.confidence - left.confidence ||
        resultDistance(left, query) - resultDistance(right, query) ||
        left.label.localeCompare(right.label, 'en-CA') ||
        left.id.localeCompare(right.id, 'en-CA'),
    );
  const deduplicated: SearchResult[] = [];
  for (const result of ranked) {
    const duplicateIndex = deduplicated.findIndex((existing) => samePlace(existing, result));
    if (duplicateIndex === -1) {
      deduplicated.push(result);
    } else if (result.details !== undefined) {
      const existing = deduplicated[duplicateIndex];
      if (existing !== undefined) {
        deduplicated[duplicateIndex] = {
          ...existing,
          details: { ...result.details, ...existing.details },
        };
      }
    }
    if (deduplicated.length === limit) {
      break;
    }
  }
  return deduplicated;
}

function combinedSource(responses: SearchResponse[]): SearchResponse['source'] {
  const firstResponse = responses.at(0);
  if (responses.length === 1 && firstResponse !== undefined) {
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
      const fixtureResponse = await fixtureProvider.search(query);
      try {
        const photonResponse = await photonProvider.search(query);
        return {
          degraded: true,
          results: mergeResults(
            [fixtureResponse.results, photonResponse.results],
            query,
            query.limit,
          ),
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
      const fixtureResponse = await fixtureProvider.search(query);
      const providerQuery = { ...query, limit: Math.min(20, query.limit * 2) };
      const providers = [
        productionProvider,
        ...(calgaryProvider === undefined ? [] : [calgaryProvider]),
      ];
      const settled = await Promise.allSettled(
        providers.map((provider) => provider.search(providerQuery)),
      );
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
          [fixtureResponse.results, ...responses.map((response) => response.results)],
          query,
          query.limit,
        ),
        source: combinedSource(responses),
      };
    },
  };
}
