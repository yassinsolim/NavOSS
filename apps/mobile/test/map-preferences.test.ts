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
      id: 'poi_general',
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
  ],
  sources: {
    openmaptiles: { type: 'vector', url: 'https://example.test/tiles.json' },
  },
  version: 8,
};

function visibility(layerId: string, customized: StyleSpecification): unknown {
  return customized.layers.find((layer) => layer.id === layerId)?.layout?.visibility;
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
