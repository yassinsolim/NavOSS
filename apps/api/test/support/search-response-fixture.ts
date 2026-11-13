import { readFileSync } from 'node:fs';
import { SearchQuerySchema, SearchResponseSchema } from '@navoss/contracts';
import { z } from 'zod/v4';

import { createProductionSearchProvider, type SearchProvider } from '../../src/search-provider.js';

// These are unmodified, normalized provider results recorded through the deployed /v1/search.
// They are not raw Nominatim HTTP payloads, nor evidence of deployed province-wide coverage.
export const SEARCH_RESPONSE_RECORDING = z
  .object({
    recordedAt: z.string(),
    cases: z.array(
      z.object({
        query: SearchQuerySchema,
        response: SearchResponseSchema,
        status: z.literal(200),
      }),
    ),
  })
  .parse(
    JSON.parse(
      readFileSync(new URL('../fixtures/search-provider-responses.json', import.meta.url), 'utf8'),
    ),
  );

export type RecordedSearchCase = (typeof SEARCH_RESPONSE_RECORDING.cases)[number];

export function recordedSearchCase(q: string, latitude = 51.0447): RecordedSearchCase {
  const recorded = SEARCH_RESPONSE_RECORDING.cases.find(
    (entry) => entry.query.q === q && entry.query.latitude === latitude,
  );
  if (recorded === undefined) throw new Error('Missing public-place search recording.');
  return recorded;
}

export function createRecordedSearchProvider(recorded: RecordedSearchCase): SearchProvider {
  return createProductionSearchProvider(undefined, {
    search: () => Promise.resolve(recorded.response),
  });
}

const RecordedPhotonFeatureSchema = z.looseObject({
  geometry: z.object({
    coordinates: z.tuple([z.number(), z.number()]),
    type: z.literal('Point'),
  }),
  properties: z.looseObject({
    city: z.string().optional(),
    country: z.string().optional(),
    district: z.string().optional(),
    housenumber: z.string().optional(),
    name: z.string().optional(),
    osm_id: z.union([z.number(), z.string()]),
    osm_key: z.string().optional(),
    osm_type: z.string(),
    osm_value: z.string().optional(),
    postcode: z.string().optional(),
    state: z.string().optional(),
    street: z.string().optional(),
  }),
  type: z.literal('Feature'),
});

export const PHOTON_RESPONSE_RECORDING = z
  .object({
    cases: z.array(
      z.object({
        query: SearchQuerySchema,
        response: z.object({
          features: z.array(RecordedPhotonFeatureSchema),
          type: z.literal('FeatureCollection'),
        }),
        status: z.literal(200),
      }),
    ),
  })
  .parse(
    JSON.parse(
      readFileSync(new URL('../fixtures/photon-search-responses.json', import.meta.url), 'utf8'),
    ),
  );

// An adapter *test vector*: these names, tags and coordinates come from the unmodified Photon
// recording above. It exercises Nominatim's documented class/type/address shape, without claiming
// that the deployed Nominatim returned these particular HTTP payloads.
export function nominatimShapeFromPhoton(feature: z.infer<typeof RecordedPhotonFeatureSchema>) {
  const { properties } = feature;
  const osmTypes: Record<string, string> = { N: 'node', W: 'way', R: 'relation' };
  const address: Record<string, string> = {};
  for (const [key, value] of Object.entries({
    city: properties.city,
    country: properties.country,
    house_number: properties.housenumber,
    postcode: properties.postcode,
    road: properties.street,
    state: properties.state,
    suburb: properties.district,
  })) {
    if (value !== undefined) address[key] = value;
  }
  return {
    address,
    class: properties.osm_key,
    display_name: [
      properties.name,
      properties.housenumber,
      properties.street,
      properties.district,
      properties.city,
      properties.state,
      properties.postcode,
      properties.country,
    ]
      .filter(Boolean)
      .join(', '),
    lat: String(feature.geometry.coordinates[1]),
    lon: String(feature.geometry.coordinates[0]),
    name: properties.name,
    osm_id: properties.osm_id,
    osm_type: osmTypes[properties.osm_type] ?? properties.osm_type,
    type: properties.osm_value,
  };
}
