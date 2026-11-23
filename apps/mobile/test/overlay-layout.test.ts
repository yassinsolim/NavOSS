import { describe, expect, it } from 'vitest';

import {
  CONTROL_MARGIN,
  controlsFollow,
  controlsFollowLimit,
  type ControlsShown,
  controlsShown,
  controlZone,
  exploreSheetDetents,
  FIT_FADE_DISTANCE,
  fitOpacity,
  fullSheetHeight,
  GUIDANCE_BANNER_HEIGHT,
  guidanceCameraPadding,
  idleCameraPadding,
  isControlInteractive,
  mapAreaInsets,
  placeSheetDetents,
  ridingControlsRoom,
  routePreviewCameraPadding,
  routePreviewSheetDetents,
  searchResultsCameraPadding,
  SIDE_PANEL_MAX_WIDTH,
  SIDE_PANEL_MIN_WIDTH,
  sidePanelFrame,
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

  describe('glass controls that come back after being hidden', () => {
    it('sorts an opacity into hidden, faded or clear', () => {
      expect(controlZone(0)).toBe('hidden');
      expect(controlZone(0.01)).toBe('faded');
      expect(controlZone(0.49)).toBe('faded');
      expect(controlZone(0.5)).toBe('clear');
      expect(controlZone(1)).toBe('clear');
    });

    it('advances the epoch only when a group is clear again after being fully hidden', () => {
      let state: ControlsShown = { epoch: 0, wasHidden: false };
      const steps: [number, number][] = [
        [1, 0],
        [0.3, 0],
        [0, 0],
        [0, 0],
        [0.2, 0],
        [0.6, 1],
        [1, 1],
        [0, 1],
        [1, 2],
      ];
      for (const [opacity, epoch] of steps) {
        state = controlsShown(state, controlZone(opacity));
        expect(state.epoch).toBe(epoch);
      }
    });

    it('does not remount a group that hovers around the interactive threshold', () => {
      // Top controls rest near half opacity on a large phone with the trip sheet expanded; a
      // banner that grows or shrinks moves them across the threshold without ever hiding them.
      let state: ControlsShown = { epoch: 0, wasHidden: false };
      for (const opacity of [0.52, 0.48, 0.51, 0.3, 0.55, 0.49, 0.5, 0.1, 0.9]) {
        state = controlsShown(state, controlZone(opacity));
      }
      expect(state.epoch).toBe(0);
    });

    it('returns the same object when nothing changed, so React does not re-render', () => {
      const state: ControlsShown = { epoch: 3, wasHidden: false };
      expect(controlsShown(state, 'clear')).toBe(state);
      expect(controlsShown(state, 'faded')).toBe(state);
      const hidden: ControlsShown = { epoch: 3, wasHidden: true };
      expect(controlsShown(hidden, 'hidden')).toBe(hidden);
      expect(controlsShown(hidden, 'faded')).toBe(hidden);
    });
  });
});

// Window sizes in density-independent points, as React Native reports them.
// Retroid Pocket Flip 2: 1920x1080 px at 400 dpi (density 2.5), landscape by nature.
const retroid = {
  bottomInset: 16,
  leftInset: 0,
  rightInset: 0,
  topInset: 24,
  windowHeight: 432,
  windowWidth: 768,
};
// A 2400x1080 px phone (density 2.625) on its side: camera cutout left, three-button bar right.
const phoneOnSide = {
  bottomInset: 0,
  leftInset: 32,
  rightInset: 48,
  topInset: 24,
  windowHeight: 411,
  windowWidth: 914,
};
// A 10 inch tablet (1280x800 points) both ways.
const tabletLandscape = {
  bottomInset: 48,
  leftInset: 0,
  rightInset: 0,
  topInset: 24,
  windowHeight: 800,
  windowWidth: 1280,
};
const tabletPortrait = { ...tabletLandscape, windowHeight: 1280, windowWidth: 800 };
const wideWindows = [
  ['Retroid 1080p landscape', retroid],
  ['2400x1080 phone on its side', phoneOnSide],
  ['10 inch tablet, landscape', tabletLandscape],
  ['10 inch tablet, portrait', tabletPortrait],
] as const;

describe('overlay layout in wide windows', () => {
  it('keeps the portrait phone layout when the width is known but narrow', () => {
    const withWidth = { ...phone, leftInset: 0, rightInset: 0, windowWidth: 402 };
    expect(sidePanelFrame(phone)).toBeUndefined();
    expect(sidePanelFrame(withWidth)).toBeUndefined();
    expect(exploreSheetDetents(withWidth)).toEqual(exploreSheetDetents(phone));
    expect(placeSheetDetents(withWidth)).toEqual(placeSheetDetents(phone));
    expect(tripSheetDetents(withWidth)).toEqual(tripSheetDetents(phone));
    expect(guidanceCameraPadding(withWidth)).toEqual(guidanceCameraPadding(phone));
    expect(idleCameraPadding(withWidth)).toBeUndefined();
    expect(mapAreaInsets(withWidth)).toEqual({ left: 0, right: 0 });
  });

  it('docks a 360 point panel to the leading edge of the Retroid screen', () => {
    expect(sidePanelFrame(retroid)).toEqual({ left: CONTROL_MARGIN, width: 360 });
    expect(mapAreaInsets(retroid)).toEqual({ left: CONTROL_MARGIN + 360, right: 0 });
  });

  it.each(wideWindows)(
    'sizes the side panel within bounds and leaves the map most of a %s',
    (_name, metrics) => {
      const panel = sidePanelFrame(metrics);
      expect(panel).toBeDefined();
      if (panel === undefined) return;
      expect(panel.left).toBeGreaterThanOrEqual(metrics.leftInset);
      expect(panel.width).toBeGreaterThanOrEqual(SIDE_PANEL_MIN_WIDTH);
      expect(panel.width).toBeLessThanOrEqual(SIDE_PANEL_MAX_WIDTH);
      const mapWidth = metrics.windowWidth - panel.left - panel.width - metrics.rightInset;
      expect(mapWidth).toBeGreaterThan(metrics.windowWidth * 0.4);
    },
  );

  it.each(wideWindows)('reduces every sheet to peek and open on a %s', (_name, metrics) => {
    const sheets = [
      exploreSheetDetents(metrics),
      placeSheetDetents(metrics),
      routePreviewSheetDetents(metrics, { demoOrigin: false }),
      routePreviewSheetDetents(metrics, { demoOrigin: true }),
      tripSheetDetents(metrics),
    ];
    for (const { initial, values } of sheets) {
      expect(values).toHaveLength(2);
      expect(values[0]).toBeLessThan(values[1] ?? 0);
      expect(values[1]).toBeLessThanOrEqual(fullSheetHeight(metrics));
      expect(values[initial]).toBeDefined();
    }
    // The explore sheet rests on the tab bar and must stay under the status bar.
    expect(exploreSheetDetents(metrics).values[1]).toBeLessThanOrEqual(
      fullSheetHeight(metrics, TAB_BAR_HEIGHT + metrics.bottomInset),
    );
  });

  it.each(wideWindows)(
    'opens the place and the preview with their details beside the map on a %s',
    (_name, metrics) => {
      expect(placeSheetDetents(metrics).initial).toBe(1);
      expect(routePreviewSheetDetents(metrics, { demoOrigin: false }).initial).toBe(1);
      expect(exploreSheetDetents(metrics).initial).toBe(0);
      expect(tripSheetDetents(metrics).initial).toBe(0);
    },
  );

  it.each(wideWindows)(
    'stops the open trip panel under the maneuver banner on a %s',
    (_name, metrics) => {
      const open = tripSheetDetents(metrics).values.at(-1) ?? 0;
      expect(metrics.windowHeight - open).toBeGreaterThanOrEqual(
        metrics.topInset + GUIDANCE_BANNER_HEIGHT,
      );
    },
  );

  it.each(wideWindows)(
    'keeps the vehicle beside the panel, low in the map, on a %s',
    (_name, metrics) => {
      const panel = sidePanelFrame(metrics);
      const padding = guidanceCameraPadding(metrics);
      if (panel === undefined) throw new Error('expected a side panel');
      // MapLibre centres the vehicle in the padded rectangle.
      const vehicleX = (padding.left + metrics.windowWidth - padding.right) / 2;
      const vehicleY = (padding.top + metrics.windowHeight - padding.bottom) / 2;
      expect(padding.left).toBeGreaterThan(panel.left + panel.width);
      expect(vehicleX).toBeGreaterThan(panel.left + panel.width);
      expect(vehicleX).toBeLessThan(metrics.windowWidth - metrics.rightInset);
      expect(vehicleY).toBeGreaterThan(metrics.windowHeight / 2);
      expect(padding.top + padding.bottom).toBeLessThan(metrics.windowHeight);
      expect(padding.left + padding.right).toBeLessThan(metrics.windowWidth);
    },
  );

  it.each(wideWindows)(
    'frames routes, results and the resting map clear of the panel on a %s',
    (_name, metrics) => {
      const panel = sidePanelFrame(metrics);
      if (panel === undefined) throw new Error('expected a side panel');
      const panelRight = panel.left + panel.width;
      for (const padding of [
        routePreviewCameraPadding(metrics, { demoOrigin: false }),
        searchResultsCameraPadding(metrics, 0),
        searchResultsCameraPadding(metrics, 2),
      ]) {
        expect(padding.left).toBeGreaterThan(panelRight);
        expect(padding.right).toBeGreaterThan(metrics.rightInset + 48);
        expect(padding.top).toBeGreaterThan(metrics.topInset);
        expect(padding.bottom).toBeGreaterThan(metrics.bottomInset);
        expect(padding.left + padding.right).toBeLessThan(metrics.windowWidth - 100);
        expect(padding.top + padding.bottom).toBeLessThan(metrics.windowHeight - 100);
      }
      expect(idleCameraPadding(metrics)).toEqual({
        bottom: 0,
        left: panelRight,
        right: metrics.rightInset,
        top: 0,
      });
    },
  );

  it('falls back to a single detent when a window is too short for peek and open', () => {
    const short = { ...retroid, windowHeight: 300, windowWidth: 640 };
    const { initial, values } = tripSheetDetents(short);
    expect(values).toHaveLength(1);
    expect(initial).toBe(0);
    expect(values[0]).toBeGreaterThan(0);
  });
});
