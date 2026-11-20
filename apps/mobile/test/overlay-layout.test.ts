import { describe, expect, it } from 'vitest';

import {
  CONTROL_MARGIN,
  controlsFollow,
  controlsFollowLimit,
  exploreSheetDetents,
  FIT_FADE_DISTANCE,
  fitOpacity,
  fullSheetHeight,
  guidanceCameraPadding,
  isControlInteractive,
  placeSheetDetents,
  ridingControlsRoom,
  routePreviewCameraPadding,
  routePreviewSheetDetents,
  searchResultsCameraPadding,
  TAB_BAR_HEIGHT,
  topControlsRoom,
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
    const fading = controlsFollow(480 + CONTROL_MARGIN / 4, 480);
    expect(fading.bottom).toBe(480 + CONTROL_MARGIN);
    expect(fading.opacity).toBeCloseTo(0.5);
    expect(controlsFollow(700, 480)).toEqual({ bottom: 480 + CONTROL_MARGIN, opacity: 0 });
  });

  describe('a control that is not clearly visible is not interactive', () => {
    it('takes touches and VoiceOver focus from half opacity up, and not below it', () => {
      expect(isControlInteractive(1)).toBe(true);
      expect(isControlInteractive(0.5)).toBe(true);
      expect(isControlInteractive(0.49)).toBe(false);
      expect(isControlInteractive(0.15)).toBe(false);
      expect(isControlInteractive(0)).toBe(false);
    });

    const phoneHeights = [568, 667, 736, 812, 844, 852, 874, 896, 926, 932, 956];
    const sheetsOf = (metrics: typeof phone) =>
      [
        ['explore', exploreSheetDetents(metrics)],
        ['place', placeSheetDetents(metrics)],
        ['preview', routePreviewSheetDetents(metrics, { demoOrigin: false })],
        ['demo preview', routePreviewSheetDetents(metrics, { demoOrigin: true })],
        ['trip', tripSheetDetents(metrics)],
      ] as const;

    it.each(phoneHeights)(
      'never leaves the bottom group visible under a sheet, on a %i pt tall phone',
      (windowHeight) => {
        const metrics = { bottomInset: windowHeight > 700 ? 34 : 0, topInset: 20, windowHeight };
        const limit = controlsFollowLimit(windowHeight);
        for (let sheetTop = 0; sheetTop <= windowHeight; sheetTop += 1) {
          const { bottom, opacity } = controlsFollow(sheetTop, limit);
          // Wherever the group is drawn below the sheet's top edge, it must be gone, and
          // while it can still be pressed it must sit wholly above the sheet.
          if (bottom < sheetTop) expect(opacity).toBe(0);
          if (isControlInteractive(opacity)) expect(bottom).toBeGreaterThanOrEqual(sheetTop);
        }
        for (const [, { values }] of sheetsOf(metrics)) {
          for (const height of values) {
            // A sheet rests at a detent: the group is there in full or not at all, never a ghost.
            expect([0, 1]).toContain(controlsFollow(height, limit).opacity);
          }
        }
      },
    );

    it.each(phoneHeights)(
      'hides the bottom group with the trip sheet expanded and returns it when collapsed, on a %i pt tall phone',
      (windowHeight) => {
        const metrics = { bottomInset: windowHeight > 700 ? 34 : 0, topInset: 20, windowHeight };
        const limit = controlsFollowLimit(windowHeight);
        const [collapsed = 0, expanded = 0] = tripSheetDetents(metrics).values;
        expect(controlsFollow(collapsed, limit).opacity).toBe(1);
        expect(controlsFollow(expanded, limit).opacity).toBe(0);
      },
    );

    it('keeps the bottom group at the route preview detent on a 667 pt phone', () => {
      const metrics = { bottomInset: 0, topInset: 20, windowHeight: 667 };
      const { initial, values } = routePreviewSheetDetents(metrics, { demoOrigin: false });
      expect(controlsFollow(values[initial] ?? 0, controlsFollowLimit(667)).opacity).toBe(1);
    });
  });

  describe('controls that must fit between the banners and the trip sheet', () => {
    const [collapsed = 0, expanded = 0] = tripSheetDetents(phone).values;
    // Maneuver banner with a lane strip: 200pt under the status bar, then two 48pt buttons.
    const bannerStack = 200;
    const topControlsBottom = phone.topInset + bannerStack + 12 + 2 * 48 + 10;

    it('is opaque with room to spare, gone with none, and fades in between', () => {
      expect(fitOpacity(FIT_FADE_DISTANCE)).toBe(1);
      expect(fitOpacity(500)).toBe(1);
      expect(fitOpacity(FIT_FADE_DISTANCE / 2)).toBeCloseTo(0.5);
      expect(fitOpacity(0)).toBe(0);
      expect(fitOpacity(-80)).toBe(0);
    });

    it('keeps the top controls when the sheet rests and hides them once it is expanded', () => {
      const room = (sheetHeight: number) =>
        topControlsRoom({
          controlsBottom: topControlsBottom,
          sheetHeight,
          windowHeight: phone.windowHeight,
        });
      expect(fitOpacity(room(collapsed))).toBe(1);
      expect(fitOpacity(room(expanded))).toBe(0);
      // Dragging up, the controls are gone before the sheet's edge reaches them.
      const hiddenAt = phone.windowHeight - topControlsBottom - CONTROL_MARGIN;
      expect(fitOpacity(room(hiddenAt))).toBe(0);
      expect(fitOpacity(room(hiddenAt - FIT_FADE_DISTANCE))).toBe(1);
    });

    it('hides the top controls sooner when more cards stack under the banner', () => {
      const sheetHeight = Math.round(phone.windowHeight * 0.4);
      const opacityFor = (stack: number) =>
        fitOpacity(
          topControlsRoom({
            controlsBottom: phone.topInset + stack + 12 + 2 * 48 + 10,
            sheetHeight,
            windowHeight: phone.windowHeight,
          }),
        );
      expect(opacityFor(200)).toBe(1);
      expect(opacityFor(200 + 176)).toBe(0);
    });

    it('keeps a readout riding the resting sheet clear of the banner and hides it when expanded', () => {
      const readoutHeight = 48;
      const clearance = 36 + 8;
      const room = (sheetHeight: number) =>
        ridingControlsRoom({
          bannerBottom: phone.topInset + bannerStack + 8,
          bottom: sheetHeight + CONTROL_MARGIN + clearance,
          height: readoutHeight,
          windowHeight: phone.windowHeight,
        });
      expect(fitOpacity(room(collapsed))).toBe(1);
      expect(fitOpacity(room(expanded))).toBe(0);
    });

    it('hides a readout on a small screen where the banner leaves no room even at rest', () => {
      const small = { bottomInset: 0, topInset: 20, windowHeight: 568 };
      const [rest = 0] = tripSheetDetents(small).values;
      const room = ridingControlsRoom({
        bannerBottom: small.topInset + 400,
        bottom: rest + CONTROL_MARGIN + 44,
        height: 48,
        windowHeight: small.windowHeight,
      });
      expect(fitOpacity(room)).toBe(0);
    });
  });
});
