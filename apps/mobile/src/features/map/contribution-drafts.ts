import AsyncStorage from '@react-native-async-storage/async-storage';

const STORAGE_KEY = 'navoss.contribution-drafts.v1';
const MAX_DRAFTS = 25;
let pendingWrite: Promise<void> = Promise.resolve();

export const CONTRIBUTION_TYPES = [
  {
    icon: { android: 'add_location_alt', ios: 'mappin.and.ellipse' },
    id: 'missing-place',
    label: 'Missing place',
  },
  {
    icon: { android: 'edit_location_alt', ios: 'pencil.and.list.clipboard' },
    id: 'place-correction',
    label: 'Place correction',
  },
  {
    icon: { android: 'route', ios: 'arrow.triangle.branch' },
    id: 'route-issue',
    label: 'Route issue',
  },
  {
    icon: { android: 'road', ios: 'road.lanes' },
    id: 'road-change',
    label: 'Road change',
  },
] as const;

export type ContributionType = (typeof CONTRIBUTION_TYPES)[number]['id'];

export interface ContributionDraft {
  createdAt: string;
  description: string;
  id: string;
  location?: string;
  type: ContributionType;
}

function isContributionType(value: unknown): value is ContributionType {
  return CONTRIBUTION_TYPES.some((type) => type.id === value);
}

export function normalizeContributionDrafts(value: unknown): ContributionDraft[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .filter((item): item is Record<string, unknown> => typeof item === 'object' && item !== null)
    .flatMap((item) => {
      const description = typeof item.description === 'string' ? item.description.trim() : '';
      const createdAt = typeof item.createdAt === 'string' ? item.createdAt : '';
      const id = typeof item.id === 'string' ? item.id : '';
      if (
        description.length === 0 ||
        description.length > 800 ||
        id.length === 0 ||
        !Number.isFinite(Date.parse(createdAt)) ||
        !isContributionType(item.type)
      ) {
        return [];
      }
      const location = typeof item.location === 'string' ? item.location.trim() : '';
      return [
        {
          createdAt,
          description,
          id,
          ...(location.length === 0 ? {} : { location: location.slice(0, 160) }),
          type: item.type,
        },
      ];
    })
    .slice(0, MAX_DRAFTS);
}

export async function loadContributionDrafts(): Promise<ContributionDraft[]> {
  try {
    await pendingWrite;
    const stored = await AsyncStorage.getItem(STORAGE_KEY);
    return stored === null ? [] : normalizeContributionDrafts(JSON.parse(stored));
  } catch {
    return [];
  }
}

export function saveContributionDrafts(drafts: readonly ContributionDraft[]): Promise<void> {
  const payload = JSON.stringify(normalizeContributionDrafts(drafts));
  const write = pendingWrite.then(() => AsyncStorage.setItem(STORAGE_KEY, payload));
  pendingWrite = write.catch(() => undefined);
  return write;
}

export function createContributionDraft(
  type: ContributionType,
  description: string,
  location?: string,
  now: Date = new Date(),
): ContributionDraft {
  const createdAt = now.toISOString();
  const normalizedLocation = location?.trim();
  return {
    createdAt,
    description: description.trim().slice(0, 800),
    id: `${createdAt}:${Math.random().toString(36).slice(2, 10)}`,
    ...(normalizedLocation === undefined || normalizedLocation.length === 0
      ? {}
      : { location: normalizedLocation.slice(0, 160) }),
    type,
  };
}
