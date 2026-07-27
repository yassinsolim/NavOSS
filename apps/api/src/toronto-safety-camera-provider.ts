import {
  OfficialSafetyCameraResponseSchema,
  type OfficialSafetyCameraResponse,
} from '@navoss/contracts';
import { z } from 'zod/v4';

const DATASET_ID = '9fcff3e1-3737-43cf-b410-05acd615e27b';
const DATASET_URL = 'https://open.toronto.ca/dataset/red-light-cameras/';
const LICENSE_URL = 'https://open.toronto.ca/open-data-licence/';
const DEFAULT_CACHE_TTL_MS = 6 * 60 * 60 * 1_000;
const DEFAULT_DATA_URL =
  'https://ckan0.cf.opendata.inter.prod-toronto.ca/dataset/9fcff3e1-3737-43cf-b410-05acd615e27b/resource/7e4ac806-4e7a-49d3-81e1-7a14375c9025/download/red-light-cameras-data-4326.geojson';
const DEFAULT_METADATA_URL =
  'https://ckan0.cf.opendata.inter.prod-toronto.ca/api/3/action/package_show?id=red-light-cameras';
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;

const TorontoCameraFeatureSchema = z
  .object({
    geometry: z
      .object({
        coordinates: z
          .array(z.tuple([z.number(), z.number()]))
          .min(1)
          .max(4),
        type: z.literal('MultiPoint'),
      })
      .strict(),
    properties: z
      .object({
        DISTRICT: z.string().min(1),
        NAME: z.string().min(1),
        RLC: z.union([z.string().min(1), z.number().int().positive()]),
      })
      .loose(),
    type: z.literal('Feature'),
  })
  .strict();

const TorontoCameraCollectionSchema = z
  .object({
    features: z.array(TorontoCameraFeatureSchema).max(1_000),
    type: z.literal('FeatureCollection'),
  })
  .loose();

const TorontoMetadataSchema = z
  .object({
    result: z
      .object({
        id: z.literal(DATASET_ID),
        last_refreshed: z.string().min(1),
        refresh_rate: z.literal('Daily'),
        state: z.literal('active'),
      })
      .loose(),
    success: z.literal(true),
  })
  .loose();

export class TorontoCameraProviderError extends Error {
  public constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'TorontoCameraProviderError';
  }
}

export interface TorontoSafetyCameraProvider {
  getCameras(): Promise<OfficialSafetyCameraResponse>;
}

interface TorontoSafetyCameraProviderOptions {
  cacheTtlMs?: number;
  clock?: () => number;
  dataUrl?: string;
  fetchImplementation?: typeof fetch;
  metadataUrl?: string;
  requestTimeoutMs?: number;
}

async function fetchJson(
  fetchImplementation: typeof fetch,
  url: string,
  requestTimeoutMs: number,
): Promise<unknown> {
  const response = await fetchImplementation(url, {
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(requestTimeoutMs),
  });
  if (!response.ok) {
    throw new TorontoCameraProviderError(`Toronto Open Data returned ${String(response.status)}.`);
  }
  return response.json();
}

function parseTorontoDate(value: string): string {
  const normalized = value.includes('T') ? value : value.replace(' ', 'T');
  const withTimezone = /(?:Z|[+-]\d\d:\d\d)$/u.test(normalized) ? normalized : `${normalized}Z`;
  const timestamp = Date.parse(withTimezone);
  if (!Number.isFinite(timestamp)) {
    throw new TorontoCameraProviderError('Toronto camera source freshness is invalid.');
  }
  return new Date(timestamp).toISOString();
}

export function createTorontoSafetyCameraProvider(
  options: TorontoSafetyCameraProviderOptions = {},
): TorontoSafetyCameraProvider {
  const cacheTtlMs = options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
  const clock = options.clock ?? Date.now;
  const dataUrl = options.dataUrl ?? DEFAULT_DATA_URL;
  const fetchImplementation = options.fetchImplementation ?? fetch;
  const metadataUrl = options.metadataUrl ?? DEFAULT_METADATA_URL;
  const requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  let cachedResponse: { expiresAt: number; value: OfficialSafetyCameraResponse } | undefined;

  return {
    async getCameras(): Promise<OfficialSafetyCameraResponse> {
      const now = clock();
      if (cachedResponse !== undefined && now < cachedResponse.expiresAt) {
        return cachedResponse.value;
      }

      try {
        const [collectionPayload, metadataPayload] = await Promise.all([
          fetchJson(fetchImplementation, dataUrl, requestTimeoutMs),
          fetchJson(fetchImplementation, metadataUrl, requestTimeoutMs),
        ]);
        const collection = TorontoCameraCollectionSchema.parse(collectionPayload);
        const metadata = TorontoMetadataSchema.parse(metadataPayload);
        const value = OfficialSafetyCameraResponseSchema.parse({
          cameras: collection.features
            .map((feature) => {
              const coordinate = feature.geometry.coordinates[0];
              if (coordinate === undefined) {
                throw new TorontoCameraProviderError('A Toronto camera coordinate is missing.');
              }
              const [longitude, latitude] = coordinate;
              return {
                coordinate: { latitude, longitude },
                enforcement: ['red-light'],
                id: `toronto-rlc:${String(feature.properties.RLC)}`,
                jurisdiction: 'City of Toronto',
                location: feature.properties.NAME.replace(/\s+/gu, ' ').trim(),
                regionId: 'toronto-on',
              };
            })
            .sort((left, right) => left.id.localeCompare(right.id, 'en-CA')),
          generatedAt: new Date(now).toISOString(),
          source: {
            attribution: 'City of Toronto',
            datasetId: DATASET_ID,
            datasetUrl: DATASET_URL,
            licenseUrl: LICENSE_URL,
            regionId: 'toronto-on',
            updateFrequency: 'daily',
            updatedAt: parseTorontoDate(metadata.result.last_refreshed),
          },
        });
        cachedResponse = { expiresAt: now + cacheTtlMs, value };
        return value;
      } catch (error: unknown) {
        if (error instanceof TorontoCameraProviderError) throw error;
        throw new TorontoCameraProviderError(
          'Official Toronto red-light-camera data could not be loaded.',
          { cause: error },
        );
      }
    },
  };
}
