import { type ColorRoles, type ColorScheme, darkColors, lightColors } from '../../theme/tokens';

/**
 * The colour scheme for controls that float over the map. They sit on the basemap, not on a
 * system surface, so they follow the basemap (the same `darkMap` signal as the status bar): a
 * Day map in a dark system still needs dark glyphs on its light glass, and a Night map in a light
 * system needs light ones.
 */
export function mapChromeScheme(darkMap: boolean): ColorScheme {
  return darkMap ? 'dark' : 'light';
}

/** The colour roles for glyphs, pills and fallback surfaces drawn on the basemap. */
export function mapChromeColors(darkMap: boolean): ColorRoles {
  return darkMap ? darkColors : lightColors;
}
