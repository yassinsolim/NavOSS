import type { StyleSpecification } from '@maplibre/maplibre-react-native';
import { useEffect, useState } from 'react';
import type { ColorSchemeName } from 'react-native';

import {
  DEFAULT_MAP_PREFERENCES,
  isDarkMapStyle,
  loadCustomizedMapStyle,
  loadMapPreferences,
  type MapPreferences,
  mapStyleInputs,
  mapStyleUrl,
  saveMapPreferences,
} from '@/features/map/map-preferences';
import { isCarPlayVisualHarness } from '@/features/navigation/native-navigation';

export interface MapPreferencesState {
  preferences: MapPreferences;
  /** Applies and persists. Persistence is best effort; the in-memory choice always wins. */
  updatePreferences: (preferences: MapPreferences) => void;
}

export function useMapPreferences(): MapPreferencesState {
  const [preferences, setPreferences] = useState(DEFAULT_MAP_PREFERENCES);

  useEffect(() => {
    if (isCarPlayVisualHarness()) return;
    let active = true;
    void loadMapPreferences().then((stored) => {
      if (active) setPreferences(stored);
    });
    return () => {
      active = false;
    };
  }, []);

  const updatePreferences = (next: MapPreferences) => {
    setPreferences(next);
    void saveMapPreferences(next).catch(() => {
      console.warn('Map preferences could not be saved locally.');
    });
  };

  return { preferences, updatePreferences };
}

export interface MapStyleState {
  /** Whether the basemap is dark, for the status bar and anything drawn directly on the map. */
  darkMap: boolean;
  mapStyle: string | StyleSpecification;
}

/**
 * The basemap style. It reloads only when something that changes the style document changes:
 * the preset, the system appearance behind `automatic`, or a basemap-layer toggle. Route colour,
 * navigation orientation and overlay toggles are drawn by our own layers and never reload it.
 */
export function useMapStyle(
  preferences: MapPreferences,
  colorScheme: ColorSchemeName,
): MapStyleState {
  const { showBuildings, showPlaces, showTransit, stylePreset } = mapStyleInputs(preferences);
  const [mapStyle, setMapStyle] = useState<string | StyleSpecification>(() =>
    mapStyleUrl(DEFAULT_MAP_PREFERENCES.stylePreset, colorScheme),
  );

  useEffect(() => {
    let active = true;
    const inputs = { showBuildings, showPlaces, showTransit, stylePreset };
    // The previous style stays on screen until the next one is ready, so a change never flashes
    // through an uncustomised basemap.
    void loadCustomizedMapStyle(inputs, colorScheme)
      .then((style) => {
        if (active) setMapStyle(style);
      })
      .catch(() => {
        if (active) setMapStyle(mapStyleUrl(stylePreset, colorScheme));
      });
    return () => {
      active = false;
    };
  }, [colorScheme, showBuildings, showPlaces, showTransit, stylePreset]);

  return { darkMap: isDarkMapStyle(stylePreset, colorScheme), mapStyle };
}
