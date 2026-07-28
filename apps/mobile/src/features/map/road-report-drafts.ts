import AsyncStorage from '@react-native-async-storage/async-storage';
import type { Coordinate } from '@navoss/contracts';

const STORAGE_KEY = 'navoss.road-report-drafts.v1';
const MAX_DRAFTS = 25;
const REPORT_LIFETIME_MS = 2 * 60 * 60 * 1_000;
let pendingWrite: Promise<void> = Promise.resolve();

export const ROAD_REPORT_TYPES = [
  {
    icon: { android: 'car_crash', ios: 'car.side.rear.and.collision.and.car.side.front' },
    id: 'collision',
    label: 'Crash',
  },
  {
    icon: { android: 'block', ios: 'road.lanes.curved.left' },
    id: 'road-closure',
    label: 'Road closed',
  },
  {
    icon: { android: 'traffic', ios: 'car.2.fill' },
    id: 'slow-traffic',
    label: 'Slow traffic',
  },
  {
    icon: { android: 'construction', ios: 'hammer.fill' },
    id: 'construction',
    label: 'Construction',
  },
  {
    icon: { android: 'report_problem', ios: 'exclamationmark.triangle.fill' },
    id: 'pothole',
    label: 'Pothole',
  },
  {
    icon: { android: 'deployed_code', ios: 'shippingbox.fill' },
    id: 'object-on-road',
    label: 'Object on road',
  },
  {
    icon: { android: 'warning', ios: 'exclamationmark.triangle.fill' },
    id: 'road-hazard',
    label: 'Other hazard',
  },
  {
    icon: { android: 'car_repair', ios: 'car.side.fill' },
    id: 'stalled-vehicle',
    label: 'Stopped vehicle',
  },
] as const;

export type RoadReportType = (typeof ROAD_REPORT_TYPES)[number]['id'];

export interface RoadReportDraft {
  coordinate: Coordinate;
  createdAt: string;
  expiresAt: string;
  id: string;
  type: RoadReportType;
}

function isRoadReportType(value: unknown): value is RoadReportType {
  return ROAD_REPORT_TYPES.some((type) => type.id === value);
}

function isCoordinate(value: unknown): value is Coordinate {
  if (typeof value !== 'object' || value === null) return false;
  const coordinate = value as Record<string, unknown>;
  return (
    typeof coordinate.latitude === 'number' &&
    Number.isFinite(coordinate.latitude) &&
    coordinate.latitude >= -90 &&
    coordinate.latitude <= 90 &&
    typeof coordinate.longitude === 'number' &&
    Number.isFinite(coordinate.longitude) &&
    coordinate.longitude >= -180 &&
    coordinate.longitude <= 180
  );
}

export function normalizeRoadReportDrafts(
  value: unknown,
  now: Date = new Date(),
): RoadReportDraft[] {
  if (!Array.isArray(value)) return [];
  const nowMs = now.getTime();

  return value
    .filter((item): item is Record<string, unknown> => typeof item === 'object' && item !== null)
    .flatMap((item) => {
      const createdAt = typeof item.createdAt === 'string' ? item.createdAt : '';
      const expiresAt = typeof item.expiresAt === 'string' ? item.expiresAt : '';
      const id = typeof item.id === 'string' ? item.id : '';
      const createdAtMs = Date.parse(createdAt);
      const expiresAtMs = Date.parse(expiresAt);
      if (
        id.length === 0 ||
        !Number.isFinite(createdAtMs) ||
        !Number.isFinite(expiresAtMs) ||
        expiresAtMs <= createdAtMs ||
        expiresAtMs <= nowMs ||
        !isRoadReportType(item.type) ||
        !isCoordinate(item.coordinate)
      ) {
        return [];
      }

      return [
        {
          coordinate: item.coordinate,
          createdAt,
          expiresAt,
          id,
          type: item.type,
        },
      ];
    })
    .slice(0, MAX_DRAFTS);
}

export function createRoadReportDraft(
  type: RoadReportType,
  coordinate: Coordinate,
  now: Date = new Date(),
): RoadReportDraft {
  const createdAt = now.toISOString();
  return {
    coordinate,
    createdAt,
    expiresAt: new Date(now.getTime() + REPORT_LIFETIME_MS).toISOString(),
    id: `${createdAt}:${Math.random().toString(36).slice(2, 10)}`,
    type,
  };
}

export async function loadRoadReportDrafts(now: Date = new Date()): Promise<RoadReportDraft[]> {
  try {
    await pendingWrite;
    const stored = await AsyncStorage.getItem(STORAGE_KEY);
    return stored === null ? [] : normalizeRoadReportDrafts(JSON.parse(stored), now);
  } catch {
    return [];
  }
}

export function saveRoadReportDrafts(
  drafts: readonly RoadReportDraft[],
  now: Date = new Date(),
): Promise<void> {
  const payload = JSON.stringify(normalizeRoadReportDrafts(drafts, now));
  const write = pendingWrite.then(() => AsyncStorage.setItem(STORAGE_KEY, payload));
  pendingWrite = write.catch(() => undefined);
  return write;
}
