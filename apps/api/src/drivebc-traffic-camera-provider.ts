import { TrafficCameraResponseSchema, type TrafficCameraResponse } from '@navoss/contracts';
import { parse } from 'csv-parse/sync';
import { z } from 'zod/v4';

const DEFAULT_DATA_URL =
  'https://catalogue.data.gov.bc.ca/dataset/6b39a910-6c77-476f-ac96-7b4f18849b1c/resource/a9d52d85-8402-4ce7-b2ac-a2779837c48a/download/webcams.csv';
const DEFAULT_CACHE_TTL_MS = 6 * 60 * 60 * 1_000;
const DEFAULT_MAXIMUM_STALE_MS = 24 * 60 * 60 * 1_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
const KELOWNA_BOUNDS = { east: -119.2, north: 50.15, south: 49.7, west: -119.65 } as const;

const CameraRowSchema = z
  .object({
    camName: z.string().trim().min(1),
    caption: z.string().trim().min(1),
    credit: z.string(),
    highway_locationDescription: z.string(),
    highway_number: z.string().trim().min(1),
    id: z.string().regex(/^\d+$/u),
    latitude: z.string().trim().min(1),
    links_bchighwaycam: z.url(),
    links_imageDisplay: z.url(),
    links_imageThumbnail: z.url(),
    links_replayTheDay: z.url(),
    longitude: z.string().trim().min(1),
    orientation: z.string(),
  })
  .strict();
const CameraRowsSchema = z.array(CameraRowSchema).max(5_000);

export class DriveBcTrafficCameraProviderError extends Error {
  public constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'DriveBcTrafficCameraProviderError';
  }
}

export interface DriveBcTrafficCameraProvider {
  getCameras(): Promise<TrafficCameraResponse>;
  start?(): void;
  stop?(): void;
}

interface DriveBcTrafficCameraProviderOptions {
  cacheTtlMs?: number;
  clock?: () => number;
  dataUrl?: string;
  fetchImplementation?: typeof fetch;
  maximumStaleMs?: number;
  refreshIntervalMs?: number;
  requestTimeoutMs?: number;
}

function parseCoordinate(value: string, minimum: number, maximum: number): number {
  const coordinate = Number(value.trim());
  if (!Number.isFinite(coordinate) || coordinate < minimum || coordinate > maximum) {
    throw new DriveBcTrafficCameraProviderError('A DriveBC camera coordinate is invalid.');
  }
  return coordinate;
}

function isInKelowna(latitude: number, longitude: number): boolean {
  return (
    latitude >= KELOWNA_BOUNDS.south &&
    latitude <= KELOWNA_BOUNDS.north &&
    longitude >= KELOWNA_BOUNDS.west &&
    longitude <= KELOWNA_BOUNDS.east
  );
}

function parseLastModified(value: string | null): string | undefined {
  if (value === null) return undefined;
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) {
    throw new DriveBcTrafficCameraProviderError('DriveBC camera freshness is invalid.');
  }
  return new Date(timestamp).toISOString();
}

export function createDriveBcTrafficCameraProvider(
  options: DriveBcTrafficCameraProviderOptions = {},
): DriveBcTrafficCameraProvider {
  const cacheTtlMs = options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
  const clock = options.clock ?? Date.now;
  const dataUrl = options.dataUrl ?? DEFAULT_DATA_URL;
  const fetchImplementation = options.fetchImplementation ?? fetch;
  const maximumStaleMs = options.maximumStaleMs ?? DEFAULT_MAXIMUM_STALE_MS;
  const refreshIntervalMs = options.refreshIntervalMs ?? cacheTtlMs;
  const requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  let cached: { expiresAt: number; loadedAt: number; value: TrafficCameraResponse } | undefined;
  let interval: ReturnType<typeof setInterval> | undefined;
  let refreshing: Promise<TrafficCameraResponse> | undefined;

  const loadCameras = async (): Promise<TrafficCameraResponse> => {
    const now = clock();
    if (cached !== undefined && now < cached.expiresAt) return cached.value;
    try {
      const response = await fetchImplementation(dataUrl, {
        headers: { accept: 'text/csv' },
        signal: AbortSignal.timeout(requestTimeoutMs),
      });
      if (!response.ok) {
        throw new DriveBcTrafficCameraProviderError(
          `DriveBC HighwayCams returned ${String(response.status)}.`,
        );
      }
      const rows = CameraRowsSchema.parse(
        parse(await response.text(), {
          bom: true,
          columns: true,
          relax_quotes: true,
          skip_empty_lines: true,
          trim: true,
        }),
      );
      const cameras = rows
        .flatMap((row) => {
          const latitude = parseCoordinate(row.latitude, -90, 90);
          const longitude = parseCoordinate(row.longitude, -180, 180);
          if (!isInKelowna(latitude, longitude)) return [];
          const orientation = row.orientation.trim();
          return [
            {
              cameraType: 'traffic' as const,
              caption: row.caption,
              coordinate: { latitude, longitude },
              enforcement: false as const,
              highway: row.highway_number,
              id: `drivebc-highwaycam:${row.id}`,
              imageUrl: row.links_imageDisplay,
              name: row.camName,
              ...(orientation.length === 0 ? {} : { orientation }),
              pageUrl: row.links_bchighwaycam,
              regionId: 'kelowna-bc' as const,
              thumbnailUrl: row.links_imageThumbnail,
            },
          ];
        })
        .sort((left, right) => left.id.localeCompare(right.id, 'en-CA'));
      const updatedAt = parseLastModified(response.headers.get('last-modified'));
      const value = TrafficCameraResponseSchema.parse({
        cameras,
        degraded: false,
        generatedAt: new Date(now).toISOString(),
        source: {
          attribution:
            'Contains information licensed under the Open Government Licence \u2013 British Columbia.',
          catalogueUrl:
            'https://catalogue.data.gov.bc.ca/dataset/6b39a910-6c77-476f-ac96-7b4f18849b1c',
          datasetId: '6b39a910-6c77-476f-ac96-7b4f18849b1c',
          dataUrl: DEFAULT_DATA_URL,
          licenseUrl: 'https://www2.gov.bc.ca/gov/content?id=A519A56BC2BF44E4A008B33FCF527F61',
          regionId: 'kelowna-bc',
          resourceId: 'a9d52d85-8402-4ce7-b2ac-a2779837c48a',
          sourceId: 'drivebc-highwaycams',
          updateFrequency: 'monthly',
          ...(updatedAt === undefined ? {} : { updatedAt }),
        },
        stale: false,
      });
      cached = { expiresAt: now + cacheTtlMs, loadedAt: now, value };
      return value;
    } catch (error: unknown) {
      if (cached !== undefined && now - cached.loadedAt <= maximumStaleMs) {
        return TrafficCameraResponseSchema.parse({
          ...cached.value,
          degraded: true,
          generatedAt: new Date(now).toISOString(),
          stale: true,
        });
      }
      if (error instanceof DriveBcTrafficCameraProviderError) throw error;
      throw new DriveBcTrafficCameraProviderError(
        'Official DriveBC HighwayCams data could not be loaded.',
        { cause: error },
      );
    }
  };

  const getCameras = (): Promise<TrafficCameraResponse> => {
    if (refreshing !== undefined) return refreshing;
    refreshing = loadCameras().finally(() => {
      refreshing = undefined;
    });
    return refreshing;
  };

  return {
    getCameras,
    start(): void {
      if (interval !== undefined) return;
      void getCameras().catch(() => undefined);
      interval = setInterval(() => void getCameras().catch(() => undefined), refreshIntervalMs);
      interval.unref();
    },
    stop(): void {
      if (interval === undefined) return;
      clearInterval(interval);
      interval = undefined;
    },
  };
}
