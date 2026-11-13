import AsyncStorage from '@react-native-async-storage/async-storage';
import type { StyleSpecification } from '@maplibre/maplibre-react-native';
import type { ColorSchemeName } from 'react-native';

import type { NavigationMapOrientation } from '@/features/navigation/navigation-camera';

const STORAGE_KEY = 'navoss.map-preferences.v1';
const OPEN_FREE_MAP_STYLE_ROOT = 'https://tiles.openfreemap.org/styles';

/**
 * The hosted style root. Development builds may point it elsewhere (for example a closed
 * loopback port) to exercise the offline fallback when the hosted style cannot load; release
 * builds always use OpenFreeMap.
 */
function hostedStyleRoot(): string {
  // `unknown`, as in `getApiBaseUrl`: `process.env` is only typed where Expo's generated
  // `expo-env.d.ts` exists, which a clean checkout (and CI) does not have.
  const override: unknown = process.env.EXPO_PUBLIC_DEBUG_MAP_STYLE_ROOT;
  const development = typeof __DEV__ !== 'undefined' && __DEV__;
  return development && typeof override === 'string' && override !== ''
    ? override
    : OPEN_FREE_MAP_STYLE_ROOT;
}
const styleCache = new Map<string, Promise<StyleSpecification>>();

export type MapStylePreset = 'automatic' | 'contrast' | 'day' | 'minimal' | 'night';
export type NavigationViewMode = 'flat' | 'tilted';
export type RouteColor = 'blue' | 'coral' | 'green' | 'violet';

export interface MapPreferences {
  navigationOrientation: NavigationMapOrientation;
  navigationView: NavigationViewMode;
  routeColor: RouteColor;
  showBuildings: boolean;
  /** Reports shared by other NavOSS drivers (drawn only where the server provides them). */
  showCommunityReports: boolean;
  showPlaces: boolean;
  showRoadEvents: boolean;
  showSafetyCameras: boolean;
  /** The community traffic-flow layer: opt-in, and only where the server publishes it. */
  showTraffic: boolean;
  showTransit: boolean;
  stylePreset: MapStylePreset;
}

export const DEFAULT_MAP_PREFERENCES: MapPreferences = {
  navigationOrientation: 'heading-up',
  navigationView: 'tilted',
  routeColor: 'green',
  showBuildings: true,
  showCommunityReports: true,
  showPlaces: true,
  showRoadEvents: true,
  showSafetyCameras: true,
  showTraffic: false,
  showTransit: true,
  stylePreset: 'automatic',
};

export const ROUTE_COLORS: Readonly<Record<RouteColor, string>> = {
  blue: '#1769AA',
  coral: '#C64B3B',
  green: '#18796F',
  violet: '#7152A1',
};

/**
 * The preferences that change the basemap style document. Everything else in `MapPreferences`
 * (route colour, navigation camera, overlay toggles) is drawn by NavOSS's own layers, so changing
 * it must not rebuild or reload the style.
 */
export type MapStyleInputs = Pick<
  MapPreferences,
  'showBuildings' | 'showPlaces' | 'showTransit' | 'stylePreset'
>;

export function mapStyleInputs(preferences: MapStyleInputs): MapStyleInputs {
  return {
    showBuildings: preferences.showBuildings,
    showPlaces: preferences.showPlaces,
    showTransit: preferences.showTransit,
    stylePreset: preferences.stylePreset,
  };
}

export function isDarkMapStyle(preset: MapStylePreset, colorScheme: ColorSchemeName): boolean {
  return preset === 'night' || (preset === 'automatic' && colorScheme === 'dark');
}

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
    showCommunityReports: isBoolean(candidate.showCommunityReports)
      ? candidate.showCommunityReports
      : DEFAULT_MAP_PREFERENCES.showCommunityReports,
    showPlaces: isBoolean(candidate.showPlaces)
      ? candidate.showPlaces
      : DEFAULT_MAP_PREFERENCES.showPlaces,
    showRoadEvents: isBoolean(candidate.showRoadEvents)
      ? candidate.showRoadEvents
      : DEFAULT_MAP_PREFERENCES.showRoadEvents,
    showSafetyCameras: isBoolean(candidate.showSafetyCameras)
      ? candidate.showSafetyCameras
      : DEFAULT_MAP_PREFERENCES.showSafetyCameras,
    showTraffic: isBoolean(candidate.showTraffic)
      ? candidate.showTraffic
      : DEFAULT_MAP_PREFERENCES.showTraffic,
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

/** The OpenFreeMap / offline-bundle style slug (`liberty`, `bright`, `positron`, `dark`). */
export function mapStyleSlug(preset: MapStylePreset, colorScheme: ColorSchemeName): string {
  return preset === 'automatic'
    ? colorScheme === 'dark'
      ? 'dark'
      : 'liberty'
    : STYLE_SLUGS[preset];
}

export function mapStyleUrl(preset: MapStylePreset, colorScheme: ColorSchemeName): string {
  return `${hostedStyleRoot()}/${mapStyleSlug(preset, colorScheme)}`;
}

/**
 * Installed offline styles, already bound to local files. The offline bundles carry the same
 * four OpenMapTiles styles as the hosted map, so every preset and toggle applies unchanged.
 */
export interface OfflineMapStyles {
  style: (slug: string) => StyleSpecification | undefined;
  /** Draw the offline map now (no connection, or the driver prefers offline maps). */
  use: boolean;
}

export interface LoadedMapStyle {
  offline: boolean;
  style: StyleSpecification;
}

function resolvedMapStylePreset(
  preset: MapStylePreset,
  colorScheme: ColorSchemeName,
): Exclude<MapStylePreset, 'automatic'> {
  return preset === 'automatic' ? (colorScheme === 'dark' ? 'night' : 'day') : preset;
}

function sourceLayer(layer: StyleSpecification['layers'][number]): string | undefined {
  return 'source-layer' in layer ? layer['source-layer'] : undefined;
}

function isLandmarkLayer(layer: StyleSpecification['layers'][number]): boolean {
  return layer.type === 'symbol' && sourceLayer(layer) === 'poi';
}

function hasLandmarkLayers(style: StyleSpecification): boolean {
  return style.layers.some(isLandmarkLayer);
}

function restoreLandmarkLayers(style: StyleSpecification, landmarkStyle: StyleSpecification): void {
  const existingLayerIds = new Set(style.layers.map((layer) => layer.id));
  for (const layer of landmarkStyle.layers) {
    if (isLandmarkLayer(layer) && !existingLayerIds.has(layer.id)) {
      style.layers.push(JSON.parse(JSON.stringify(layer)) as typeof layer);
    }
  }
}

function layerPaint(layer: StyleSpecification['layers'][number]): Record<string, unknown> {
  layer.paint ??= {};
  return layer.paint;
}

function applyTextPalette(
  layer: StyleSpecification['layers'][number],
  textColor: string,
  haloColor: string,
): void {
  if (layer.type !== 'symbol') {
    return;
  }

  const paint = layerPaint(layer);
  if ('text-color' in paint) {
    paint['text-color'] = textColor;
    paint['text-halo-color'] = haloColor;
    paint['text-halo-width'] = 1.5;
  }
}

function applyDayRoadPalette(layer: StyleSpecification['layers'][number]): void {
  if (layer.type !== 'line') {
    return;
  }

  const paint = layerPaint(layer);
  if (/(^|_)motorway(?:_|$)/.test(layer.id)) {
    paint['line-color'] = layer.id.includes('casing')
      ? '#3F7150'
      : layer.id.includes('link')
        ? '#9AC69D'
        : '#72AD7B';
    paint['line-opacity'] = 1;
    return;
  }

  if (layer.id.includes('trunk_primary')) {
    const existingColor = paint['line-color'] ?? '#F5D49B';
    paint['line-color'] = [
      'match',
      ['get', 'class'],
      'trunk',
      layer.id.includes('casing') ? '#547A55' : '#A6C98C',
      existingColor,
    ];
  }
}

function applyNightPalette(layer: StyleSpecification['layers'][number]): void {
  const paint = layerPaint(layer);
  const source = sourceLayer(layer);

  if (layer.type === 'background') {
    paint['background-color'] = '#172121';
  } else if (source === 'water' || layer.id.startsWith('water')) {
    if (layer.type === 'fill') paint['fill-color'] = '#173B4A';
    if (layer.type === 'line') paint['line-color'] = '#2F7186';
    applyTextPalette(layer, '#8ED8EE', '#172121');
    return;
  } else if (source === 'park' || /landcover|park|wood|grass/.test(layer.id)) {
    if (layer.type === 'fill') paint['fill-color'] = '#1E3A32';
    if (layer.type === 'line') paint['line-color'] = '#315A4A';
  } else if (source === 'building' || layer.id.startsWith('building')) {
    if (layer.type === 'fill') {
      paint['fill-color'] = '#293535';
      paint['fill-outline-color'] = '#3E4B4A';
    }
    if (layer.type === 'fill-extrusion') {
      paint['fill-extrusion-color'] = '#293535';
    }
  } else if (layer.type === 'line' && /highway|road/.test(layer.id)) {
    paint['line-color'] = layer.id.includes('casing')
      ? '#0D1515'
      : /motorway|trunk|primary/.test(layer.id)
        ? '#C9A052'
        : /secondary|tertiary|major/.test(layer.id)
          ? '#8A8375'
          : '#4E5A58';
  }

  applyTextPalette(layer, '#ECE8DF', '#172121');
}

function applyContrastPalette(layer: StyleSpecification['layers'][number]): void {
  const paint = layerPaint(layer);
  const source = sourceLayer(layer);

  if (layer.type === 'background') {
    paint['background-color'] = '#FFFFFF';
  } else if (source === 'water' || layer.id.startsWith('water')) {
    if (layer.type === 'fill') paint['fill-color'] = '#83CFEA';
    if (layer.type === 'line') paint['line-color'] = '#08779C';
    applyTextPalette(layer, '#064A63', '#FFFFFF');
    return;
  } else if (source === 'park' || /landcover|park|wood|grass/.test(layer.id)) {
    if (layer.type === 'fill') {
      paint['fill-color'] = '#B9E59D';
      paint['fill-opacity'] = 1;
    }
    if (layer.type === 'line') paint['line-color'] = '#3C782A';
  } else if (source === 'building' || layer.id.startsWith('building')) {
    if (layer.type === 'fill') {
      paint['fill-color'] = '#D8D8D3';
      paint['fill-outline-color'] = '#656C69';
    }
    if (layer.type === 'fill-extrusion') {
      paint['fill-extrusion-color'] = '#D8D8D3';
    }
  } else if (layer.type === 'line' && /highway|road/.test(layer.id)) {
    paint['line-color'] = layer.id.includes('casing')
      ? '#343B39'
      : /motorway|trunk/.test(layer.id)
        ? '#FFC928'
        : /primary|secondary|tertiary|major/.test(layer.id)
          ? '#FFF09A'
          : '#FFFFFF';
    paint['line-opacity'] = 1;
  }

  applyTextPalette(layer, '#101817', '#FFFFFF');
}

function applyMinimalLandmarkPalette(layer: StyleSpecification['layers'][number]): void {
  if (isLandmarkLayer(layer)) {
    applyTextPalette(layer, '#4B5554', 'rgba(255,255,255,0.9)');
  }
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
  preferences: MapStyleInputs,
  colorScheme: ColorSchemeName = 'light',
  landmarkStyle: StyleSpecification = style,
): StyleSpecification {
  const customized = JSON.parse(JSON.stringify(style)) as StyleSpecification;
  restoreLandmarkLayers(customized, landmarkStyle);
  const resolvedPreset = resolvedMapStylePreset(preferences.stylePreset, colorScheme);

  for (const layer of customized.layers) {
    if (resolvedPreset === 'day') applyDayRoadPalette(layer);
    if (resolvedPreset === 'night') applyNightPalette(layer);
    if (resolvedPreset === 'contrast') applyContrastPalette(layer);
    if (resolvedPreset === 'minimal') applyMinimalLandmarkPalette(layer);

    const layerSource = sourceLayer(layer);
    const transit = isTransitLayer(layer);
    if (!preferences.showBuildings && layerSource === 'building') {
      hideLayer(layer);
    }
    if (!preferences.showTransit && transit) {
      hideLayer(layer);
    }
    if (!preferences.showPlaces && layerSource === 'poi' && !transit) {
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

function loadHostedMapStyle(
  url: string,
  fetchImplementation: typeof fetch,
): Promise<StyleSpecification> {
  let pendingStyle = styleCache.get(url);
  if (pendingStyle === undefined) {
    pendingStyle = fetchMapStyle(url, fetchImplementation);
    styleCache.set(url, pendingStyle);
    pendingStyle.catch(() => {
      styleCache.delete(url);
    });
  }
  return pendingStyle;
}

export async function loadCustomizedMapStyle(
  preferences: MapStyleInputs,
  colorScheme: ColorSchemeName,
  fetchImplementation: typeof fetch = fetch,
  offline?: OfflineMapStyles,
): Promise<LoadedMapStyle> {
  const slug = mapStyleSlug(preferences.stylePreset, colorScheme);
  const offlineStyle = (): LoadedMapStyle | undefined => {
    const style = offline?.style(slug);
    if (style === undefined) return undefined;
    const landmarkStyle = hasLandmarkLayers(style) ? style : (offline?.style('liberty') ?? style);
    return {
      offline: true,
      style: customizeMapStyle(style, preferences, colorScheme, landmarkStyle),
    };
  };
  if (offline?.use === true) {
    const local = offlineStyle();
    if (local !== undefined) return local;
  }
  try {
    const url = mapStyleUrl(preferences.stylePreset, colorScheme);
    const style = await loadHostedMapStyle(url, fetchImplementation);
    const landmarkStyle = hasLandmarkLayers(style)
      ? style
      : await loadHostedMapStyle(mapStyleUrl('day', colorScheme), fetchImplementation);
    return {
      offline: false,
      style: customizeMapStyle(style, preferences, colorScheme, landmarkStyle),
    };
  } catch (error: unknown) {
    // The hosted style is unreachable: a downloaded region keeps the map usable.
    const local = offlineStyle();
    if (local !== undefined) return local;
    throw error;
  }
}
