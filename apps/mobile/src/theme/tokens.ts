import type { TextStyle, ViewStyle } from 'react-native';

/**
 * NavOSS design tokens. Colour roles come from the shared design seed (ink/paper surfaces, a
 * teal-green primary, sun accent, coral danger). Components consume roles, never raw palette
 * values, so light and dark stay first-class and a palette change is one edit here.
 */

export const palette = {
  amber: '#F59E0B',
  coral: '#E5484D',
  ink: '#0E1516',
  paper: '#F6F7F3',
  sun: '#F7C948',
  tealDark: '#3DD6B5',
  tealLight: '#0F8F7F',
  white: '#FFFFFF',
} as const;

/** Traffic ramp shared with CarPlay and the site. Wave 2's traffic-flow layer colours by these. */
export const trafficColors = {
  free: '#2FBF71',
  heavy: '#E5484D',
  slow: '#F5A524',
  stopped: '#8B1E2D',
} as const;

export type ColorScheme = 'dark' | 'light';

export interface ColorRoles {
  /** App canvas behind full-screen pages. */
  background: string;
  /** Hairlines and control outlines. */
  border: string;
  borderStrong: string;
  danger: string;
  dangerSoft: string;
  /** Danger-coloured text that passes contrast on `surface`. */
  dangerText: string;
  /** Text and icons on `danger`. */
  onDanger: string;
  /** Text and icons on `primary`. */
  onPrimary: string;
  /** Text and icons on `sun`. */
  onSun: string;
  overlay: string;
  pressed: string;
  primary: string;
  primarySoft: string;
  /** Primary-coloured text and icons that pass contrast on `surface`. */
  primaryText: string;
  scrim: string;
  success: string;
  sun: string;
  sunSoft: string;
  /** Sheets, cards and floating controls. */
  surface: string;
  /** A surface stacked on `surface` (selected cards, popovers). */
  surfaceRaised: string;
  /** Wells: inputs, icon wells, segmented tracks. */
  surfaceSunken: string;
  text: string;
  textSecondary: string;
  textTertiary: string;
  warning: string;
  warningSoft: string;
  warningText: string;
}

export const lightColors: ColorRoles = {
  background: palette.paper,
  border: '#D9DFDB',
  borderStrong: '#B4BEB9',
  danger: palette.coral,
  dangerSoft: '#FCE9E9',
  dangerText: '#B4262C',
  onDanger: palette.white,
  onPrimary: palette.white,
  onSun: palette.ink,
  overlay: 'rgba(14,21,22,0.06)',
  pressed: 'rgba(14,21,22,0.08)',
  primary: palette.tealLight,
  primarySoft: '#DCF1EC',
  primaryText: '#0A6F63',
  scrim: 'rgba(14,21,22,0.42)',
  success: '#1F9D5B',
  sun: palette.sun,
  sunSoft: '#FDF3D0',
  surface: palette.white,
  surfaceRaised: palette.white,
  surfaceSunken: '#EEF1EC',
  text: palette.ink,
  textSecondary: '#46524F',
  textTertiary: '#5C6865',
  warning: palette.amber,
  warningSoft: '#FEF0D2',
  warningText: '#8A5300',
};

export const darkColors: ColorRoles = {
  background: palette.ink,
  border: '#2B3A3B',
  borderStrong: '#435556',
  danger: palette.coral,
  dangerSoft: '#3B1C1E',
  dangerText: '#FF8A8D',
  onDanger: palette.white,
  onPrimary: '#04261F',
  onSun: palette.ink,
  overlay: 'rgba(255,255,255,0.06)',
  pressed: 'rgba(255,255,255,0.10)',
  primary: palette.tealDark,
  primarySoft: '#143B35',
  primaryText: palette.tealDark,
  scrim: 'rgba(0,0,0,0.56)',
  success: '#2FBF71',
  sun: palette.sun,
  sunSoft: '#3A3212',
  surface: '#151F20',
  surfaceRaised: '#1E2B2C',
  surfaceSunken: '#0E1516',
  text: '#F2F5F2',
  textSecondary: '#B5C1BE',
  textTertiary: '#8B9895',
  warning: palette.amber,
  warningSoft: '#3A2A0B',
  warningText: '#FBC25B',
};

/**
 * Active guidance is always rendered on ink, in both schemes: a driver glancing at the phone gets
 * the same high-contrast banner at noon and at night, and it never flashes when the system flips.
 */
export const guidanceColors = {
  background: palette.ink,
  backgroundRaised: '#1E2B2C',
  border: '#2B3A3B',
  maneuver: palette.tealLight,
  primary: palette.tealDark,
  text: palette.white,
  textSecondary: '#C3CECB',
} as const;

export const fonts = {
  bold: 'AtkinsonHyperlegibleNext_700Bold',
  medium: 'AtkinsonHyperlegibleNext_500Medium',
  regular: 'AtkinsonHyperlegibleNext_400Regular',
  semibold: 'AtkinsonHyperlegibleNext_600SemiBold',
} as const;

function text(
  fontFamily: string,
  fontSize: number,
  lineHeight: number,
  letterSpacing = 0,
): TextStyle {
  return { fontFamily, fontSize, letterSpacing, lineHeight };
}

/** Type scale. Guidance sizes are deliberately large: they are read at arm's length, moving. */
export const typography = {
  body: text(fonts.regular, 16, 22),
  bodyStrong: text(fonts.semibold, 16, 22),
  callout: text(fonts.medium, 15, 20),
  caption: text(fonts.medium, 12, 16),
  eyebrow: { ...text(fonts.bold, 12, 16, 0.6), textTransform: 'uppercase' },
  footnote: text(fonts.regular, 13, 18),
  footnoteStrong: text(fonts.semibold, 13, 18),
  guidanceDistance: text(fonts.bold, 38, 42),
  guidanceInstruction: text(fonts.bold, 24, 28),
  guidanceMetric: text(fonts.bold, 26, 30),
  guidanceRoad: text(fonts.medium, 18, 22),
  headline: text(fonts.semibold, 17, 22),
  label: text(fonts.semibold, 15, 20),
  largeTitle: text(fonts.bold, 32, 38),
  title1: text(fonts.bold, 26, 32),
  title2: text(fonts.bold, 22, 28),
  title3: text(fonts.semibold, 19, 24),
} as const satisfies Record<string, TextStyle>;

export const space = {
  hairline: 1,
  xxs: 2,
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 20,
  xxl: 24,
  xxxl: 32,
  huge: 48,
} as const;

export const radius = {
  sm: 8,
  md: 12,
  lg: 16,
  xl: 22,
  sheet: 26,
  pill: 999,
} as const;

/** Minimum touch targets. Controls a driver reaches for while guidance runs use `driving`. */
export const touchTarget = {
  driving: 56,
  min: 44,
} as const;

export const elevation = {
  high: {
    elevation: 12,
    shadowColor: '#000000',
    shadowOffset: { height: 8, width: 0 },
    shadowOpacity: 0.22,
    shadowRadius: 24,
  },
  low: {
    elevation: 2,
    shadowColor: '#000000',
    shadowOffset: { height: 1, width: 0 },
    shadowOpacity: 0.1,
    shadowRadius: 3,
  },
  medium: {
    elevation: 6,
    shadowColor: '#000000',
    shadowOffset: { height: 3, width: 0 },
    shadowOpacity: 0.16,
    shadowRadius: 10,
  },
  none: {},
} as const satisfies Record<string, ViewStyle>;

/**
 * Motion clarifies state and never decorates. Every animation built from these passes
 * `ReduceMotion.System`, so Reduce Motion collapses them to their end state.
 */
export const motion = {
  duration: {
    base: 220,
    fast: 150,
    instant: 90,
    slow: 320,
  },
  spring: {
    /** Press feedback on buttons and chips. */
    press: { damping: 22, mass: 0.6, stiffness: 420 },
    /** Sheet settle: critically damped enough to never bounce past a detent. */
    sheet: { damping: 34, mass: 1, stiffness: 330 },
  },
} as const;
