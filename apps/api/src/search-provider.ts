import type { SearchQuery, SearchResponse, SearchResult } from '@navoss/contracts';
import { z } from 'zod/v4';

import { CALGARY_SEARCH_FIXTURES, type SearchFixture } from './fixtures.js';
import { searchFixtures } from './search.js';

const DEFAULT_PHOTON_URL = 'https://photon.komoot.io/api/';
const PHOTON_TIMEOUT_MS = 3_000;
const CALGARY_BOUNDS = '-114.316,50.842,-113.859,51.212';

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

export interface SearchProvider {
  search(query: SearchQuery): Promise<SearchResponse>;
}

export interface PhotonSearchProviderOptions {
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
