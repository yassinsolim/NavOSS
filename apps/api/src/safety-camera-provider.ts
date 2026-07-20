import {
  SafetyCameraResponseSchema,
  type SafetyCamera,
  type SafetyCameraDirection,
  type SafetyCameraResponse,
} from '@navoss/contracts';
import { z } from 'zod/v4';

const CAMERA_DATASET_ID = 'dv2f-necx';
const CAMERA_DATASET_URL =
  'https://data.calgary.ca/Health-and-Safety/Intersection-Safety-Cameras/dv2f-necx';
const DEFAULT_CACHE_TTL_MS = 6 * 60 * 60 * 1_000;
const DEFAULT_DATA_URL = `https://data.calgary.ca/resource/${CAMERA_DATASET_ID}.json`;
const DEFAULT_METADATA_URL = `https://data.calgary.ca/api/views/${CAMERA_DATASET_ID}`;
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;

const CameraRowSchema = z
  .object({
    community: z.string().min(1),
    description: z.string().min(1),
    point: z
      .object({
        coordinates: z.tuple([z.number(), z.number()]),
        type: z.literal('Point'),
      })
      .loose(),
    quadrant: z.enum(['NE', 'NW', 'SE', 'SW']),
    ward: z.coerce.number().int().min(1).max(14).optional(),
  })
  .loose();

const CameraRowsSchema = z.array(CameraRowSchema).max(500);
const DatasetMetadataSchema = z.object({ rowsUpdatedAt: z.number().int().positive() }).loose();

const DIRECTION_PATTERN = /\b(Northbound|Southbound|Eastbound|Westbound|NB|SB|EB|WB)\s*$/i;

const DIRECTION_BY_LABEL: Readonly<Record<string, SafetyCameraDirection>> = {
  eastbound: 'eastbound',
  eb: 'eastbound',
  northbound: 'northbound',
  nb: 'northbound',
  southbound: 'southbound',
  sb: 'southbound',
  westbound: 'westbound',
  wb: 'westbound',
};

export class CameraProviderError extends Error {
  public constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'CameraProviderError';
  }
}

export interface SafetyCameraProvider {
  getCameras(): Promise<SafetyCameraResponse>;
}

interface CalgarySafetyCameraProviderOptions {
  cacheTtlMs?: number;
  clock?: () => number;
  dataUrl?: string;
  fetchImplementation?: typeof fetch;
  metadataUrl?: string;
  requestTimeoutMs?: number;
}

function normalizeCamera(row: z.infer<typeof CameraRowSchema>): SafetyCamera {
  const directionMatch = DIRECTION_PATTERN.exec(row.description);
  if (directionMatch?.index === undefined) {
    throw new CameraProviderError('A camera direction could not be normalized.');
  }

  const directionLabel = directionMatch[1]?.toLocaleLowerCase('en-CA');
  const direction = directionLabel === undefined ? undefined : DIRECTION_BY_LABEL[directionLabel];
  if (direction === undefined) {
    throw new CameraProviderError('A camera direction could not be normalized.');
  }

  const [longitude, latitude] = row.point.coordinates;
  const location = row.description
    .slice(0, directionMatch.index)
    .replace(/\s*Direction\s*:?\s*$/i, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (location.length === 0) {
    throw new CameraProviderError('A camera location could not be normalized.');
  }

  return {
    community: row.community,
    coordinate: { latitude, longitude },
    direction,
    enforcement: ['red-light', 'speed-on-green'],
    id: `calgary-isc:${latitude.toFixed(7)}:${longitude.toFixed(7)}`,
    location,
    quadrant: row.quadrant,
    ...(row.ward === undefined ? {} : { ward: row.ward }),
  };
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
    throw new CameraProviderError(`Calgary Open Data returned ${String(response.status)}.`);
  }
  return response.json();
}

export function createCalgarySafetyCameraProvider(
  options: CalgarySafetyCameraProviderOptions = {},
): SafetyCameraProvider {
  const cacheTtlMs = options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
  const clock = options.clock ?? Date.now;
  const dataUrl = new URL(options.dataUrl ?? DEFAULT_DATA_URL);
  dataUrl.searchParams.set('$limit', '500');
  dataUrl.searchParams.set('$select', 'description,quadrant,community,ward,point');
  const fetchImplementation = options.fetchImplementation ?? fetch;
  const metadataUrl = options.metadataUrl ?? DEFAULT_METADATA_URL;
  const requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  let cachedResponse: { expiresAt: number; value: SafetyCameraResponse } | undefined;

  return {
    async getCameras(): Promise<SafetyCameraResponse> {
      const now = clock();
      if (cachedResponse !== undefined && now < cachedResponse.expiresAt) {
        return cachedResponse.value;
      }

      try {
        const [rowsPayload, metadataPayload] = await Promise.all([
          fetchJson(fetchImplementation, dataUrl.toString(), requestTimeoutMs),
          fetchJson(fetchImplementation, metadataUrl, requestTimeoutMs),
        ]);
        const rows = CameraRowsSchema.parse(rowsPayload);
        const metadata = DatasetMetadataSchema.parse(metadataPayload);
        const value = SafetyCameraResponseSchema.parse({
          cameras: rows
            .map(normalizeCamera)
            .sort((left, right) => left.id.localeCompare(right.id, 'en-CA')),
          source: {
            attribution: 'The City of Calgary',
            datasetId: CAMERA_DATASET_ID,
            datasetUrl: CAMERA_DATASET_URL,
            updateFrequency: 'monthly',
            updatedAt: new Date(metadata.rowsUpdatedAt * 1_000).toISOString(),
          },
        });
        cachedResponse = { expiresAt: now + cacheTtlMs, value };
        return value;
      } catch (error: unknown) {
        if (error instanceof CameraProviderError) {
          throw error;
        }
        throw new CameraProviderError('Official Calgary camera data could not be loaded.', {
          cause: error,
        });
      }
    },
  };
}
