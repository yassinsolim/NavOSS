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
 * Highest a sheet's edge may carry the floating bottom group: 60% of the window, which keeps the
 * route preview's default detent on a 667 pt phone (58%) in reach and the expanded trip panel
 * (62%) out of it.
 */
export function controlsFollowLimit(windowHeight: number): number {
  return Math.round(windowHeight * 0.6);
}

/**
 * Opacity below which a floating control is not clearly visible. A control that is not clearly
 * visible is not interactive: it takes no touches and leaves VoiceOver focus, so the driver
 * never presses or hears a button they can barely see. One rule for every faded group.
 */
export const CONTROL_INTERACTIVE_OPACITY = 0.5;

export function isControlInteractive(opacity: number): boolean {
  'worklet';
  return opacity >= CONTROL_INTERACTIVE_OPACITY;
}

/** Distance past the follow limit over which the bottom group fades out; half the margin, so it is gone well before the sheet reaches it. */
const CONTROLS_FOLLOW_FADE = CONTROL_MARGIN / 2;

/**
 * How far floating controls follow a sheet. They ride its top edge up to `followLimit`; past it
 * they hold still and are gone before the sheet's edge reaches their lower edge, so a control
 * is never drawn under a sheet and a sheet at full height never pushes buttons under the status
 * bar. They are fully opaque anywhere they ride, so a sheet resting at a detent never leaves
 * them half faded.
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
    opacity: overshoot <= 0 ? 1 : Math.max(0, 1 - overshoot / CONTROLS_FOLLOW_FADE),
  };
}

/** Distance over which a control fades out as the room left for it runs out. */
export const FIT_FADE_DISTANCE = 24;

/**
 * Opacity of a floating control that must not overlap its neighbours: opaque with
 * `FIT_FADE_DISTANCE` or more room to spare, gone at none. It is fully transparent before it
 * would touch the banner or the sheet, so a control never shows clipped.
 */
export function fitOpacity(room: number): number {
  'worklet';
  return Math.min(1, Math.max(0, room / FIT_FADE_DISTANCE));
}

/**
 * Room between controls hung under the guidance banners and the top edge of the trip sheet
 * (`sheetHeight` is how far the sheet reaches up from the bottom of the screen). Negative once
 * the sheet reaches into the controls.
 */
export function topControlsRoom({
  controlsBottom,
  sheetHeight,
  windowHeight,
}: {
  /** Distance from the top of the screen to the lower edge of the controls. */
  controlsBottom: number;
  sheetHeight: number;
  windowHeight: number;
}): number {
  'worklet';
  return windowHeight - sheetHeight - CONTROL_MARGIN - controlsBottom;
}

/**
 * Room between the guidance banners and a control that rides above the trip sheet: `bottom` is
 * the distance from the bottom of the screen to the control's lower edge, `height` its height.
 * Negative once the control would reach into the banners.
 */
export function ridingControlsRoom({
  bannerBottom,
  bottom,
  height,
  windowHeight,
}: {
  /** Distance from the top of the screen to the lower edge of the banner stack. */
  bannerBottom: number;
  bottom: number;
  height: number;
  windowHeight: number;
}): number {
  'worklet';
  return windowHeight - bottom - height - bannerBottom;
}

/** Where a fading group of controls stands: gone, drawn but not yet usable, or usable. */
export type ControlZone = 'hidden' | 'faded' | 'clear';

export function controlZone(opacity: number): ControlZone {
  'worklet';
  if (opacity <= 0) return 'hidden';
  return isControlInteractive(opacity) ? 'clear' : 'faded';
}

/**
 * Tracks when a group of controls has come back after being fully hidden. `epoch` rises once
 * each time the group is clear again after its opacity reached zero. A group that only dips
 * below the interactive threshold and returns, as top controls do when the banner changes height
 * while the trip sheet is expanded, keeps its epoch: its glass was never laid out hidden, and
 * remounting it would flicker and drop a press in progress.
 */
export interface ControlsShown {
  epoch: number;
  wasHidden: boolean;
}

export function controlsShown(previous: ControlsShown, zone: ControlZone): ControlsShown {
  if (zone === 'hidden') {
    return previous.wasHidden ? previous : { epoch: previous.epoch, wasHidden: true };
  }
  if (zone === 'clear' && previous.wasHidden) {
    return { epoch: previous.epoch + 1, wasHidden: false };
  }
  return previous;
}
