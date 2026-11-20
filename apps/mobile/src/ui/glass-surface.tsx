import { GlassView, isLiquidGlassAvailable } from 'expo-glass-effect';
import type { ReactNode } from 'react';
import { type StyleProp, StyleSheet, View, type ViewStyle } from 'react-native';

import { type ColorScheme, createSchemeStyles, elevation, useTheme } from '@/theme';

// Resolved once: the answer depends on the OS and the SDK the binary was built with, neither of
// which changes while the app runs.
let liquidGlass: boolean | undefined;

export function supportsLiquidGlass(): boolean {
  if (liquidGlass === undefined) {
    try {
      liquidGlass = isLiquidGlassAvailable();
    } catch {
      liquidGlass = false;
    }
  }
  return liquidGlass;
}

interface GlassSurfaceProps {
  children?: ReactNode;
  /** Glass reacts to touch (highlight and lensing). Use for controls, not passive panels. */
  interactive?: boolean;
  /**
   * Colour scheme of the glass, for controls that sit on the basemap and so follow it, not the
   * system appearance. Defaults to the system.
   */
  scheme?: ColorScheme;
  style?: StyleProp<ViewStyle>;
}

/**
 * Material for controls that float over the map. iOS 26 Liquid Glass where the system offers it;
 * everywhere else an opaque themed surface with a hairline and shadow, which keeps the same
 * contrast over any basemap.
 */
export function GlassSurface({ children, interactive = false, scheme, style }: GlassSurfaceProps) {
  const system = useTheme().scheme;
  const styles = stylesFor(scheme ?? system);
  if (supportsLiquidGlass()) {
    return (
      <GlassView
        colorScheme={scheme ?? 'auto'}
        glassEffectStyle="regular"
        isInteractive={interactive}
        style={style}
      >
        {children}
      </GlassView>
    );
  }
  return <View style={[styles.solid, style]}>{children}</View>;
}

const stylesFor = createSchemeStyles(({ colors }) =>
  StyleSheet.create({
    solid: {
      backgroundColor: colors.surface,
      borderColor: colors.border,
      borderWidth: StyleSheet.hairlineWidth,
      ...elevation.medium,
    },
  }),
);
