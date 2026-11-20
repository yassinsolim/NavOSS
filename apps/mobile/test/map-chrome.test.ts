import { describe, expect, it } from 'vitest';

import { isDarkMapStyle, type MapStylePreset } from '../src/features/map/map-preferences.js';
import { mapChromeColors, mapChromeScheme } from '../src/features/map/map-chrome.js';
import { darkColors, lightColors } from '../src/theme/tokens.js';

function channel(value: number): number {
  const normalized = value / 255;
  return normalized <= 0.039_28 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
}

function luminance(hex: string): number {
  const red = Number.parseInt(hex.slice(1, 3), 16);
  const green = Number.parseInt(hex.slice(3, 5), 16);
  const blue = Number.parseInt(hex.slice(5, 7), 16);
  return 0.2126 * channel(red) + 0.7152 * channel(green) + 0.0722 * channel(blue);
}

function contrast(foreground: string, background: string): number {
  const [lighter, darker] = [luminance(foreground), luminance(background)].sort(
    (left, right) => right - left,
  );
  return ((lighter ?? 0) + 0.05) / ((darker ?? 0) + 0.05);
}

const presets: MapStylePreset[] = ['automatic', 'day', 'night', 'contrast', 'minimal'];
const systems = ['light', 'dark'] as const;

describe('floating map controls take their colours from the basemap', () => {
  it('uses dark glyphs on the light map and light glyphs on the dark map', () => {
    expect(mapChromeColors(false).text).toBe(lightColors.text);
    expect(mapChromeColors(true).text).toBe(darkColors.text);
    expect(mapChromeScheme(false)).toBe('light');
    expect(mapChromeScheme(true)).toBe('dark');
  });

  it.each(systems.flatMap((system) => presets.map((preset) => [system, preset] as const)))(
    'with the %s system and the %s map, the glyph reads on the glass drawn over that map',
    (system, preset) => {
      const darkMap = isDarkMapStyle(preset, system);
      const colors = mapChromeColors(darkMap);
      // Glass over a light map is light and over a dark map dark, whatever the system is.
      const glass = darkMap ? darkColors.surface : lightColors.surface;
      expect(contrast(colors.text, glass)).toBeGreaterThanOrEqual(7);
      expect(contrast(colors.primaryText, glass)).toBeGreaterThanOrEqual(4.5);
    },
  );

  it('keeps dark glyphs on a Day map in a dark system and light glyphs on a Night map in a light system', () => {
    expect(mapChromeColors(isDarkMapStyle('day', 'dark')).text).toBe(lightColors.text);
    expect(mapChromeColors(isDarkMapStyle('night', 'light')).text).toBe(darkColors.text);
  });

  it('follows the system only on the automatic map', () => {
    expect(mapChromeScheme(isDarkMapStyle('automatic', 'light'))).toBe('light');
    expect(mapChromeScheme(isDarkMapStyle('automatic', 'dark'))).toBe('dark');
  });
});
