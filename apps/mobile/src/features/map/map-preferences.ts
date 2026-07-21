import AsyncStorage from '@react-native-async-storage/async-storage';
import type { StyleSpecification } from '@maplibre/maplibre-react-native';
import type { ColorSchemeName } from 'react-native';

import type { NavigationMapOrientation } from '@/features/navigation/navigation-camera';

const STORAGE_KEY = 'navoss.map-preferences.v1';
const OPEN_FREE_MAP_STYLE_ROOT = 'https://tiles.openfreemap.org/styles';
const styleCache = new Map<string, Promise<StyleSpecification>>();

export type MapStylePreset = 'automatic' | 'contrast' | 'day' | 'minimal' | 'night';
export type NavigationViewMode = 'flat' | 'tilted';
export type RouteColor = 'blue' | 'coral' | 'green' | 'violet';

export interface MapPreferences {
  navigationOrientation: NavigationMapOrientation;
  navigationView: NavigationViewMode;
  routeColor: RouteColor;
  showBuildings: boolean;
  showPlaces: boolean;
  showSafetyCameras: boolean;
  showTransit: boolean;
  stylePreset: MapStylePreset;
}

export const DEFAULT_MAP_PREFERENCES: MapPreferences = {
  navigationOrientation: 'heading-up',
  navigationView: 'tilted',
  routeColor: 'green',
  showBuildings: true,
  showPlaces: true,
  showSafetyCameras: true,
  showTransit: true,
  stylePreset: 'automatic',
};

export const ROUTE_COLORS: Readonly<Record<RouteColor, string>> = {
  blue: '#1769AA',
  coral: '#C64B3B',
  green: '#18796F',
  violet: '#7152A1',
};

const STYLE_SLUGS: Readonly<Record<Exclude<MapStylePreset, 'automatic'>, string>> = {
  contrast: 'bright',
  day: 'liberty',
  minimal: 'positron',
  night: 'dark',
};

function isBoolean(value: unknown): value is boolean {
  return typeof value === 'boolean';
}

function isOneOf<T extends string>(value: unknown, choices: readonly T[]): value is T {
  return typeof value === 'string' && choices.includes(value as T);
}

export function normalizeMapPreferences(value: unknown): MapPreferences {
  if (typeof value !== 'object' || value === null) {
    return DEFAULT_MAP_PREFERENCES;
  }

  const candidate = value as Partial<Record<keyof MapPreferences, unknown>>;
  return {
    navigationOrientation: isOneOf(candidate.navigationOrientation, ['heading-up', 'north-up'])
      ? candidate.navigationOrientation
      : DEFAULT_MAP_PREFERENCES.navigationOrientation,
    navigationView: isOneOf(candidate.navigationView, ['flat', 'tilted'])
      ? candidate.navigationView
      : DEFAULT_MAP_PREFERENCES.navigationView,
    routeColor: isOneOf(candidate.routeColor, ['blue', 'coral', 'green', 'violet'])
      ? candidate.routeColor
      : DEFAULT_MAP_PREFERENCES.routeColor,
    showBuildings: isBoolean(candidate.showBuildings)
      ? candidate.showBuildings
      : DEFAULT_MAP_PREFERENCES.showBuildings,
    showPlaces: isBoolean(candidate.showPlaces)
      ? candidate.showPlaces
      : DEFAULT_MAP_PREFERENCES.showPlaces,
    showSafetyCameras: isBoolean(candidate.showSafetyCameras)
      ? candidate.showSafetyCameras
      : DEFAULT_MAP_PREFERENCES.showSafetyCameras,
    showTransit: isBoolean(candidate.showTransit)
      ? candidate.showTransit
      : DEFAULT_MAP_PREFERENCES.showTransit,
    stylePreset: isOneOf(candidate.stylePreset, [
      'automatic',
      'contrast',
      'day',
      'minimal',
      'night',
    ])
      ? candidate.stylePreset
      : DEFAULT_MAP_PREFERENCES.stylePreset,
  };
}

export function mapStyleUrl(preset: MapStylePreset, colorScheme: ColorSchemeName): string {
  const slug =
    preset === 'automatic' ? (colorScheme === 'dark' ? 'dark' : 'liberty') : STYLE_SLUGS[preset];
  return `${OPEN_FREE_MAP_STYLE_ROOT}/${slug}`;
}

function isTransitLayer(layer: StyleSpecification['layers'][number]): boolean {
  const sourceLayer = 'source-layer' in layer ? layer['source-layer'] : undefined;
  const filter = 'filter' in layer ? layer.filter : undefined;
  const searchable = `${layer.id} ${sourceLayer ?? ''} ${JSON.stringify(filter ?? '')}`;
  return /transit|railway|major_rail|minor_rail|poi_transit|"rail"|"bus"/i.test(searchable);
}

function hideLayer(layer: StyleSpecification['layers'][number]): void {
  layer.layout = { ...layer.layout, visibility: 'none' };
}

export function customizeMapStyle(
  style: StyleSpecification,
  preferences: MapPreferences,
): StyleSpecification {
  const customized = JSON.parse(JSON.stringify(style)) as StyleSpecification;

  for (const layer of customized.layers) {
    const sourceLayer = 'source-layer' in layer ? layer['source-layer'] : undefined;
    const transit = isTransitLayer(layer);
    if (!preferences.showBuildings && sourceLayer === 'building') {
      hideLayer(layer);
    }
    if (!preferences.showTransit && transit) {
      hideLayer(layer);
    }
    if (!preferences.showPlaces && sourceLayer === 'poi' && !transit) {
      hideLayer(layer);
    }
  }

  return customized;
}

export async function loadMapPreferences(): Promise<MapPreferences> {
  try {
    const stored = await AsyncStorage.getItem(STORAGE_KEY);
    return stored === null ? DEFAULT_MAP_PREFERENCES : normalizeMapPreferences(JSON.parse(stored));
  } catch {
    return DEFAULT_MAP_PREFERENCES;
  }
}

export async function saveMapPreferences(preferences: MapPreferences): Promise<void> {
  await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(preferences));
}

export function isStyleSpecification(value: unknown): value is StyleSpecification {
  if (typeof value !== 'object' || value === null) {
    return false;
  }

  const candidate = value as { layers?: unknown; sources?: unknown; version?: unknown };
  return (
    candidate.version === 8 &&
    Array.isArray(candidate.layers) &&
    candidate.sources !== null &&
    typeof candidate.sources === 'object'
  );
}

async function fetchMapStyle(
  url: string,
  fetchImplementation: typeof fetch,
): Promise<StyleSpecification> {
  const response = await fetchImplementation(url, { headers: { accept: 'application/json' } });
  if (!response.ok) {
    throw new Error(`Map style returned ${String(response.status)}.`);
  }

  const payload: unknown = await response.json();
  if (!isStyleSpecification(payload)) {
    throw new Error('Map style response is invalid.');
  }
  return payload;
}

export async function loadCustomizedMapStyle(
  preferences: MapPreferences,
  colorScheme: ColorSchemeName,
  fetchImplementation: typeof fetch = fetch,
): Promise<StyleSpecification> {
  const url = mapStyleUrl(preferences.stylePreset, colorScheme);
  let pendingStyle = styleCache.get(url);
  if (pendingStyle === undefined) {
    pendingStyle = fetchMapStyle(url, fetchImplementation);
    styleCache.set(url, pendingStyle);
    pendingStyle.catch(() => {
      styleCache.delete(url);
    });
  }
  return customizeMapStyle(await pendingStyle, preferences);
}
