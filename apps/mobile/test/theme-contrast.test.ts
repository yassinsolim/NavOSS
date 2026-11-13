import { describe, expect, it } from 'vitest';

import {
  type ColorRoles,
  darkColors,
  guidanceColors,
  lightColors,
  palette,
} from '../src/theme/tokens.js';

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

/** WCAG 2 contrast ratio between two opaque colours. */
function contrast(foreground: string, background: string): number {
  const [lighter, darker] = [luminance(foreground), luminance(background)].sort(
    (left, right) => right - left,
  );
  return ((lighter ?? 0) + 0.05) / ((darker ?? 0) + 0.05);
}

const BODY_TEXT = 4.5;
const LARGE_TEXT = 3;

describe.each([
  ['light', lightColors],
  ['dark', darkColors],
] as const)('%s colour roles', (_scheme, colors: ColorRoles) => {
  it.each(['surface', 'surfaceRaised', 'surfaceSunken', 'background'] as const)(
    'keeps every text role readable on %s',
    (surface) => {
      for (const role of ['text', 'textSecondary', 'textTertiary', 'primaryText'] as const) {
        expect(
          contrast(colors[role], colors[surface]),
          `${role} on ${surface}`,
        ).toBeGreaterThanOrEqual(BODY_TEXT);
      }
    },
  );

  it('keeps status text readable on its own tinted background', () => {
    expect(contrast(colors.dangerText, colors.dangerSoft)).toBeGreaterThanOrEqual(BODY_TEXT);
    expect(contrast(colors.warningText, colors.warningSoft)).toBeGreaterThanOrEqual(BODY_TEXT);
    expect(contrast(colors.primaryText, colors.primarySoft)).toBeGreaterThanOrEqual(BODY_TEXT);
    expect(contrast(colors.text, colors.primarySoft)).toBeGreaterThanOrEqual(BODY_TEXT);
    expect(contrast(colors.dangerText, colors.surface)).toBeGreaterThanOrEqual(BODY_TEXT);
  });

  it('keeps button labels, which are bold and at least 16pt, readable on their fills', () => {
    expect(contrast(colors.onPrimary, colors.primary)).toBeGreaterThanOrEqual(LARGE_TEXT);
    expect(contrast(colors.onDanger, colors.danger)).toBeGreaterThanOrEqual(LARGE_TEXT);
    expect(contrast(colors.onSun, colors.sun)).toBeGreaterThanOrEqual(BODY_TEXT);
  });
});

describe('guidance colours', () => {
  it('holds glanceable contrast for everything on the maneuver banner', () => {
    expect(contrast(guidanceColors.text, guidanceColors.background)).toBeGreaterThanOrEqual(7);
    expect(
      contrast(guidanceColors.textSecondary, guidanceColors.background),
    ).toBeGreaterThanOrEqual(7);
    expect(contrast(palette.white, guidanceColors.maneuver)).toBeGreaterThanOrEqual(LARGE_TEXT);
    expect(contrast(palette.ink, palette.sun)).toBeGreaterThanOrEqual(7);
  });
});
