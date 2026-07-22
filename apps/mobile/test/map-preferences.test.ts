import type { StyleSpecification } from '@maplibre/maplibre-react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: vi.fn(),
    setItem: vi.fn(),
  },
}));

import {
  customizeMapStyle,
  DEFAULT_MAP_PREFERENCES,
  loadMapPreferences,
  loadCustomizedMapStyle,
  mapStyleUrl,
  normalizeMapPreferences,
  saveMapPreferences,
} from '../src/features/map/map-preferences.js';

const style: StyleSpecification = {
  layers: [
    { id: 'background', paint: { 'background-color': '#ffffff' }, type: 'background' },
    {
      id: 'building',
      source: 'openmaptiles',
      'source-layer': 'building',
      type: 'fill',
    },
    {
      id: 'building_3d',
      source: 'openmaptiles',
      'source-layer': 'building',
      type: 'fill-extrusion',
    },
    {
      id: 'poi_general',
      paint: { 'text-color': '#666666', 'text-halo-color': '#ffffff' },
      source: 'openmaptiles',
      'source-layer': 'poi',
      type: 'symbol',
    },
    {
      filter: ['==', ['get', 'class'], 'transit'],
      id: 'railway_transit',
      source: 'openmaptiles',
      'source-layer': 'transportation',
      type: 'line',
    },
    {
      filter: ['match', ['get', 'class'], ['airport', 'bus', 'rail'], true, false],
      id: 'poi_transit',
      source: 'openmaptiles',
      'source-layer': 'poi',
      type: 'symbol',
    },
    {
      id: 'road',
      source: 'openmaptiles',
      'source-layer': 'transportation',
      type: 'line',
    },
    {
      id: 'water_name',
      paint: { 'text-color': '#495e91', 'text-halo-color': '#ffffff' },
      source: 'openmaptiles',
      'source-layer': 'water_name',
      type: 'symbol',
    },
  ],
  sources: {
    openmaptiles: { type: 'vector', url: 'https://example.test/tiles.json' },
  },
  version: 8,
};

function visibility(layerId: string, customized: StyleSpecification): unknown {
  return customized.layers.find((layer) => layer.id === layerId)?.layout?.visibility;
}

function paint(layerId: string, property: string, customized: StyleSpecification): unknown {
  const layer = customized.layers.find((candidate) => candidate.id === layerId);
  return layer?.paint === undefined
    ? undefined
    : (layer.paint as Record<string, unknown>)[property];
}

describe('map preferences', () => {
  it('defaults invalid persisted values without discarding valid choices', () => {
    expect(
      normalizeMapPreferences({
        navigationOrientation: 'north-up',
        routeColor: 'invalid',
        showBuildings: false,
        stylePreset: 'night',
      }),
    ).toEqual({
      ...DEFAULT_MAP_PREFERENCES,
      navigationOrientation: 'north-up',
      showBuildings: false,
      stylePreset: 'night',
    });
  });

  it('selects day or night automatically from the system scheme', () => {
    expect(mapStyleUrl('automatic', 'light')).toMatch(/\/liberty$/);
    expect(mapStyleUrl('automatic', 'dark')).toMatch(/\/dark$/);
    expect(mapStyleUrl('contrast', 'dark')).toMatch(/\/bright$/);
    expect(mapStyleUrl('minimal', 'light')).toMatch(/\/positron$/);
  });

  it('hides requested content without hiding roads', () => {
    const customized = customizeMapStyle(style, {
      ...DEFAULT_MAP_PREFERENCES,
      showBuildings: false,
      showPlaces: false,
      showTransit: false,
    });

    expect(visibility('building', customized)).toBe('none');
    expect(visibility('poi_general', customized)).toBe('none');
    expect(visibility('railway_transit', customized)).toBe('none');
    expect(visibility('poi_transit', customized)).toBe('none');
    expect(visibility('road', customized)).toBeUndefined();
    expect(visibility('background', customized)).toBeUndefined();
    expect(visibility('building', style)).toBeUndefined();
  });

  it('keeps transit POIs when only general places are hidden', () => {
    const customized = customizeMapStyle(style, {
      ...DEFAULT_MAP_PREFERENCES,
      showPlaces: false,
      showTransit: true,
    });

    expect(visibility('poi_general', customized)).toBe('none');
    expect(visibility('poi_transit', customized)).toBeUndefined();
  });

  it('restores readable landmarks in night and minimal styles', () => {
    const styleWithoutLandmarks: StyleSpecification = {
      ...style,
      layers: style.layers.filter(
        (layer) => !(layer.type === 'symbol' && layer['source-layer'] === 'poi'),
      ),
    };
    const night = customizeMapStyle(
      styleWithoutLandmarks,
      { ...DEFAULT_MAP_PREFERENCES, stylePreset: 'night' },
      'dark',
      style,
    );
    const minimal = customizeMapStyle(
      styleWithoutLandmarks,
      { ...DEFAULT_MAP_PREFERENCES, stylePreset: 'minimal' },
      'light',
      style,
    );

    expect(night.layers.some((layer) => layer.id === 'poi_general')).toBe(true);
    expect(paint('poi_general', 'text-color', night)).toBe('#ECE8DF');
    expect(minimal.layers.some((layer) => layer.id === 'poi_general')).toBe(true);
    expect(paint('poi_general', 'text-color', minimal)).toBe('#4B5554');
  });

  it('gives night and contrast visibly different palettes', () => {
    const night = customizeMapStyle(
      style,
      { ...DEFAULT_MAP_PREFERENCES, stylePreset: 'night' },
      'dark',
    );
    const contrast = customizeMapStyle(style, {
      ...DEFAULT_MAP_PREFERENCES,
      stylePreset: 'contrast',
    });

    expect(paint('background', 'background-color', night)).toBe('#172121');
    expect(paint('background', 'background-color', contrast)).toBe('#FFFFFF');
    expect(paint('road', 'line-color', night)).toBe('#4E5A58');
    expect(paint('road', 'line-color', contrast)).toBe('#FFFFFF');
    expect(paint('water_name', 'text-color', night)).toBe('#8ED8EE');
    expect(paint('water_name', 'text-color', contrast)).toBe('#064A63');
    expect(paint('building_3d', 'fill-extrusion-color', contrast)).toBe('#D8D8D3');
  });

  it('loads the selected hosted style and applies content preferences', async () => {
    const fetchImplementation = vi.fn(() =>
      Promise.resolve(
        new Response(JSON.stringify(style), {
          headers: { 'content-type': 'application/json' },
          status: 200,
        }),
      ),
    );

    const customized = await loadCustomizedMapStyle(
      {
        ...DEFAULT_MAP_PREFERENCES,
        showBuildings: false,
        stylePreset: 'contrast',
      },
      'light',
      fetchImplementation,
    );

    expect(fetchImplementation).toHaveBeenCalledWith(
      'https://tiles.openfreemap.org/styles/bright',
      { headers: { accept: 'application/json' } },
    );
    expect(visibility('building', customized)).toBe('none');
  });

  it('loads day landmarks when a hosted preset omits POI layers', async () => {
    const styleWithoutLandmarks: StyleSpecification = {
      ...style,
      layers: style.layers.filter(
        (layer) => !(layer.type === 'symbol' && layer['source-layer'] === 'poi'),
      ),
    };
    const fetchImplementation = vi.fn((input: RequestInfo | URL) => {
      if (typeof input !== 'string') {
        throw new Error('Expected a string map-style URL.');
      }
      const responseStyle = input.endsWith('/dark') ? styleWithoutLandmarks : style;
      return Promise.resolve(new Response(JSON.stringify(responseStyle), { status: 200 }));
    });

    const customized = await loadCustomizedMapStyle(
      { ...DEFAULT_MAP_PREFERENCES, stylePreset: 'night' },
      'dark',
      fetchImplementation,
    );

    expect(fetchImplementation).toHaveBeenNthCalledWith(
      1,
      'https://tiles.openfreemap.org/styles/dark',
      { headers: { accept: 'application/json' } },
    );
    expect(fetchImplementation).toHaveBeenNthCalledWith(
      2,
      'https://tiles.openfreemap.org/styles/liberty',
      { headers: { accept: 'application/json' } },
    );
    expect(paint('poi_general', 'text-color', customized)).toBe('#ECE8DF');
  });

  it('loads and saves preferences only in local app storage', async () => {
    vi.mocked(AsyncStorage.getItem).mockResolvedValueOnce(
      JSON.stringify({ stylePreset: 'night', showSafetyCameras: false }),
    );
    const preferences = await loadMapPreferences();

    expect(preferences).toEqual({
      ...DEFAULT_MAP_PREFERENCES,
      showSafetyCameras: false,
      stylePreset: 'night',
    });
    await saveMapPreferences(preferences);
    expect(AsyncStorage.setItem).toHaveBeenCalledWith(
      'navoss.map-preferences.v1',
      JSON.stringify(preferences),
    );
  });
});
