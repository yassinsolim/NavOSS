import { describe, expect, it } from 'vitest';

import {
  CONTROL_MARGIN,
  controlsFollow,
  exploreSheetDetents,
  fullSheetHeight,
  guidanceCameraPadding,
  placeSheetDetents,
  routePreviewCameraPadding,
  routePreviewSheetDetents,
  searchResultsCameraPadding,
  TAB_BAR_HEIGHT,
  tripSheetDetents,
} from '../src/features/map/overlay-layout.js';

const phone = { bottomInset: 34, topInset: 62, windowHeight: 874 };
const smallPhone = { bottomInset: 0, topInset: 20, windowHeight: 568 };

describe('overlay layout', () => {
  it.each([
    ['explore', exploreSheetDetents],
    ['place', placeSheetDetents],
    ['trip', tripSheetDetents],
  ] as const)('gives the %s sheet ascending detents that fit the screen', (_name, detents) => {
    for (const metrics of [phone, smallPhone]) {
      const { initial, values } = detents(metrics);
      expect(values).toEqual([...values].sort((left, right) => left - right));
      expect(values.at(-1)).toBeLessThanOrEqual(fullSheetHeight(metrics));
      expect(values[initial]).toBeDefined();
    }
  });

  it('leaves the map visible above the resting explore sheet so a long-press can reach it', () => {
    const { initial, values } = exploreSheetDetents(phone);
    const covered = (values[initial] ?? 0) + TAB_BAR_HEIGHT + phone.bottomInset;
    expect(covered).toBeLessThan(phone.windowHeight * 0.35);
  });

  it('opens the route preview at its middle detent and makes room for the demo-origin notice', () => {
    const live = routePreviewSheetDetents(phone, { demoOrigin: false });
    const demo = routePreviewSheetDetents(phone, { demoOrigin: true });
    expect(live.initial).toBe(1);
    expect(live.values).toHaveLength(3);
    expect(demo.values[1]).toBeGreaterThan(live.values[1] ?? 0);
  });

  it('frames a previewed route in the map the preview sheet leaves visible', () => {
    const detents = routePreviewSheetDetents(phone, { demoOrigin: false });
    const padding = routePreviewCameraPadding(phone, { demoOrigin: false });
    expect(padding.bottom).toBeGreaterThan(detents.values[detents.initial] ?? 0);
    expect(padding.top).toBeGreaterThan(phone.topInset);
    expect(padding.top + padding.bottom).toBeLessThan(phone.windowHeight);
  });

  it('never frames search results for a sheet taller than half the screen', () => {
    const half = searchResultsCameraPadding(phone, 1);
    expect(searchResultsCameraPadding(phone, 2)).toEqual(half);
    expect(searchResultsCameraPadding(phone, 0).bottom).toBeLessThan(half.bottom);
    expect(half.top + half.bottom).toBeLessThan(phone.windowHeight);
  });

  it('keeps the vehicle between the maneuver banner and the trip panel', () => {
    const padding = guidanceCameraPadding(phone);
    expect(padding.bottom).toBeGreaterThan(tripSheetDetents(phone).values[0] ?? 0);
    expect(padding.top).toBeGreaterThan(phone.topInset + 100);
  });

  it('floats controls on the sheet edge, then holds and fades them once the sheet passes the limit', () => {
    expect(controlsFollow(200, 480)).toEqual({ bottom: 200 + CONTROL_MARGIN, opacity: 1 });
    expect(controlsFollow(480, 480)).toEqual({ bottom: 480 + CONTROL_MARGIN, opacity: 1 });
    const fading = controlsFollow(504, 480);
    expect(fading.bottom).toBe(480 + CONTROL_MARGIN);
    expect(fading.opacity).toBeCloseTo(0.5);
    expect(controlsFollow(700, 480)).toEqual({ bottom: 480 + CONTROL_MARGIN, opacity: 0 });
  });
});
