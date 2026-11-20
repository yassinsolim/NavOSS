import { useColorScheme } from 'react-native';

import {
  type ColorRoles,
  type ColorScheme,
  darkColors,
  elevation,
  fonts,
  guidanceColors,
  lightColors,
  motion,
  radius,
  space,
  touchTarget,
  trafficColors,
  typography,
} from '@/theme/tokens';

export interface Theme {
  colors: ColorRoles;
  scheme: ColorScheme;
}

const THEMES: Readonly<Record<ColorScheme, Theme>> = {
  dark: { colors: darkColors, scheme: 'dark' },
  light: { colors: lightColors, scheme: 'light' },
};

export function themeForScheme(scheme: string | null | undefined): Theme {
  return scheme === 'dark' ? THEMES.dark : THEMES.light;
}

/** The whole UI follows the system appearance; there is no in-app override. */
export function useTheme(): Theme {
  return themeForScheme(useColorScheme());
}

/**
 * Builds a style sheet once per colour scheme, for surfaces that take their colours from
 * something other than the system appearance (the basemap behind floating map controls).
 * Factories must depend only on the theme.
 */
export function createSchemeStyles<T>(factory: (theme: Theme) => T): (scheme: ColorScheme) => T {
  const cache: Partial<Record<ColorScheme, T>> = {};
  return function stylesForScheme(scheme: ColorScheme): T {
    return (cache[scheme] ??= factory(THEMES[scheme]));
  };
}

/**
 * Builds a style sheet once per colour scheme. Factories must depend only on the theme, so both
 * results are cached for the life of the app and a scheme flip swaps object identity, not values.
 */
export function createThemedStyles<T>(factory: (theme: Theme) => T): () => T {
  const stylesForScheme = createSchemeStyles(factory);
  return function useThemedStyles(): T {
    return stylesForScheme(useTheme().scheme);
  };
}

export {
  elevation,
  fonts,
  guidanceColors,
  motion,
  radius,
  space,
  touchTarget,
  trafficColors,
  typography,
};
export type { ColorRoles, ColorScheme };
