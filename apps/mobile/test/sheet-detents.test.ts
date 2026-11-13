import { describe, expect, it } from 'vitest';

import {
  detentAfterRelease,
  draggedSheetHeight,
  resolveSheetDetents,
} from '../src/ui/sheet/sheet-detents.js';

describe('sheet detents', () => {
  it('resolves detents ascending, distinct, and never taller than the space available', () => {
    expect(resolveSheetDetents([700, 140, 380], 0, 600)).toEqual([140, 380, 600]);
    // Two detents that clamp to the same height collapse into one resting position.
    expect(resolveSheetDetents([650, 900], 0, 600)).toEqual([600]);
  });

  it('sizes a content detent from the measured content and waits until it is measured', () => {
    expect(resolveSheetDetents(['content'], 0, 600)).toEqual([]);
    expect(resolveSheetDetents(['content'], 312, 600)).toEqual([312]);
    expect(resolveSheetDetents(['content'], 900, 600)).toEqual([600]);
  });

  it('settles a slow release on the nearest detent', () => {
    const detents = [140, 380, 700];
    expect(detentAfterRelease({ detents, dismissible: false, height: 200, velocityY: 0 })).toEqual({
      dismiss: false,
      index: 0,
    });
    expect(detentAfterRelease({ detents, dismissible: false, height: 290, velocityY: 0 })).toEqual({
      dismiss: false,
      index: 1,
    });
  });

  it('lets a short fast flick carry the sheet to the next detent', () => {
    const detents = [140, 380, 700];
    // 20 points above the lowest detent, flicked upward: lands on the middle detent.
    expect(
      detentAfterRelease({ detents, dismissible: false, height: 160, velocityY: -1_200 }),
    ).toEqual({ dismiss: false, index: 1 });
    // The same position flicked downward stays at the lowest detent instead of leaving.
    expect(
      detentAfterRelease({ detents, dismissible: false, height: 160, velocityY: 2_000 }),
    ).toEqual({ dismiss: false, index: 0 });
  });

  it('dismisses only a dismissible sheet, and only once it is clearly on its way out', () => {
    const detents = [300];
    expect(detentAfterRelease({ detents, dismissible: true, height: 260, velocityY: 0 })).toEqual({
      dismiss: false,
      index: 0,
    });
    expect(detentAfterRelease({ detents, dismissible: true, height: 120, velocityY: 0 })).toEqual({
      dismiss: true,
      index: 0,
    });
    expect(
      detentAfterRelease({ detents, dismissible: true, height: 280, velocityY: 1_500 }),
    ).toEqual({ dismiss: true, index: 0 });
    expect(
      detentAfterRelease({ detents, dismissible: false, height: 20, velocityY: 3_000 }),
    ).toEqual({ dismiss: false, index: 0 });
  });

  it('tracks the finger inside the range and resists past either end', () => {
    const range = { dismissible: false, max: 700, min: 140, stiffTop: false };
    expect(draggedSheetHeight({ ...range, raw: 420 })).toBe(420);
    const above = draggedSheetHeight({ ...range, raw: 800 });
    expect(above).toBeGreaterThan(700);
    expect(above).toBeLessThan(720);
    const below = draggedSheetHeight({ ...range, raw: 60 });
    expect(below).toBeLessThan(140);
    expect(below).toBeGreaterThan(100);
  });

  it('stops dead at the top when a list owns the overscroll, and follows down when dismissible', () => {
    expect(
      draggedSheetHeight({ dismissible: false, max: 700, min: 140, raw: 900, stiffTop: true }),
    ).toBe(700);
    expect(
      draggedSheetHeight({ dismissible: true, max: 300, min: 300, raw: 90, stiffTop: false }),
    ).toBe(90);
    expect(
      draggedSheetHeight({ dismissible: true, max: 300, min: 300, raw: -400, stiffTop: false }),
    ).toBe(0);
  });
});
