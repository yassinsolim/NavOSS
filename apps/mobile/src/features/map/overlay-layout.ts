/**
 * Where the sheets rest and how much of the map they cover. Sheet positions are animated on the
 * UI thread; these numbers are only the resting detents and the camera padding that keeps routes
 * and results in the part of the map a sheet leaves visible.
 */

export const TAB_BAR_HEIGHT = 56;

/** Space floating controls keep from the sheet edge and the screen edge. */
export const CONTROL_MARGIN = 12;

export interface ScreenMetrics {
  bottomInset: number;
  topInset: number;
  windowHeight: number;
}

export interface SheetDetents {
  /** Index the sheet opens at. */
  initial: number;
  values: number[];
}

function fraction(metrics: ScreenMetrics, value: number): number {
  return Math.round(metrics.windowHeight * value);
}

/** Tallest a sheet may rest: just under the status bar. */
export function fullSheetHeight(metrics: ScreenMetrics, bottomOffset = 0): number {
  return Math.max(0, metrics.windowHeight - metrics.topInset - 8 - bottomOffset);
}

/** The explore sheet sits on the tab bar: search field and category chips at rest. */
export function exploreSheetDetents(metrics: ScreenMetrics): SheetDetents {
  const bottomOffset = TAB_BAR_HEIGHT + metrics.bottomInset;
  return {
    initial: 0,
    values: [142, fraction(metrics, 0.44), fullSheetHeight(metrics, bottomOffset)],
  };
}

/** Place details: name and actions at rest, details at half, photos and reviews at full. */
export function placeSheetDetents(metrics: ScreenMetrics): SheetDetents {
  return {
    initial: 0,
    values: [218 + metrics.bottomInset, fraction(metrics, 0.52), fullSheetHeight(metrics)],
  };
}

/**
 * Route preview: arrival summary and Start at the lowest detent, alternatives and stops at the
 * middle one it opens to, avoidances and marker choice above that.
 */
export function routePreviewSheetDetents(
  metrics: ScreenMetrics,
  { demoOrigin }: { demoOrigin: boolean },
): SheetDetents {
  const middle = (demoOrigin ? 452 : 388) + metrics.bottomInset;
  return {
    initial: 1,
    values: [168 + metrics.bottomInset, middle, Math.min(fullSheetHeight(metrics), middle + 250)],
  };
}

/** Trip panel: arrival, time, distance and the four driving controls at rest. */
export function tripSheetDetents(metrics: ScreenMetrics): SheetDetents {
  return {
    initial: 0,
    values: [164 + metrics.bottomInset, fraction(metrics, 0.62)],
  };
}

export interface CameraPadding {
  bottom: number;
  left: number;
  right: number;
  top: number;
}

/** Height of the maneuver banner below the status bar, including its gap to the map. */
export const GUIDANCE_BANNER_HEIGHT = 152;

/** Space a safety-camera alert takes under the maneuver banner, including its gap. */
export const CAMERA_ALERT_HEIGHT = 76;

/** Space a reroute offer takes under the maneuver banner, including its gap. */
export const REROUTE_CARD_HEIGHT = 176;

/** Padding that frames a previewed route between the top controls and the preview sheet. */
export function routePreviewCameraPadding(
  metrics: ScreenMetrics,
  options: { demoOrigin: boolean },
): CameraPadding {
  const detents = routePreviewSheetDetents(metrics, options);
  return {
    bottom: (detents.values[detents.initial] ?? 0) + 28,
    left: 40,
    right: 40,
    top: metrics.topInset + 72,
  };
}

/** Padding that frames search results above the explore sheet at the given detent. */
export function searchResultsCameraPadding(
  metrics: ScreenMetrics,
  detentIndex: number,
): CameraPadding {
  const detents = exploreSheetDetents(metrics);
  // Above the half detent the sheet covers the map; frame for the half detent instead.
  const height = detents.values[Math.min(detentIndex, 1)] ?? 0;
  return {
    bottom: height + TAB_BAR_HEIGHT + metrics.bottomInset + 32,
    left: 54,
    right: 54,
    top: metrics.topInset + 72,
  };
}

/** Padding that keeps the vehicle between the maneuver banner and the resting trip panel. */
export function guidanceCameraPadding(metrics: ScreenMetrics): CameraPadding {
  return {
    bottom: (tripSheetDetents(metrics).values[0] ?? 0) + 16,
    left: 24,
    right: 24,
    top: metrics.topInset + GUIDANCE_BANNER_HEIGHT + 24,
  };
}

/**
 * How far floating controls follow a sheet. They ride its top edge up to `followLimit` and
 * then fade out, so a sheet at full height never pushes buttons under the status bar.
 */
export function controlsFollow(
  sheetTop: number,
  followLimit: number,
): { bottom: number; opacity: number } {
  'worklet';
  const bottom = Math.min(sheetTop, followLimit) + CONTROL_MARGIN;
  const overshoot = sheetTop - followLimit;
  return {
    bottom,
    opacity: overshoot <= 0 ? 1 : Math.max(0, 1 - overshoot / 48),
  };
}
