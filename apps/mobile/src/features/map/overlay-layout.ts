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
  /**
   * Window width and side insets. Without a width the layout is the portrait phone's (iOS is
   * portrait-only); with one, a landscape or tablet-wide window gets the side panel.
   */
  windowWidth?: number;
  leftInset?: number;
  rightInset?: number;
}

/** Narrowest and widest a side panel gets. */
export const SIDE_PANEL_MIN_WIDTH = 360;
export const SIDE_PANEL_MAX_WIDTH = 420;

/** Narrowest portrait window that gets the side panel too: a 7 inch tablet and up. */
export const SIDE_PANEL_PORTRAIT_MIN_WIDTH = 600;

/**
 * The column sheets and the guidance banners take in a wide window, measured from the left edge
 * of the screen. The map fills the screen behind it; everything else floats to its right.
 */
export interface SidePanelFrame {
  left: number;
  width: number;
}

/**
 * Where the side panel sits, or `undefined` for the portrait phone layout (bottom sheets across
 * the full width). A landscape window, or a portrait one at least `SIDE_PANEL_PORTRAIT_MIN_WIDTH`
 * wide, docks sheets to the leading edge instead of stretching them across the map.
 */
export function sidePanelFrame(metrics: ScreenMetrics): SidePanelFrame | undefined {
  const { windowHeight, windowWidth } = metrics;
  if (windowWidth === undefined) return undefined;
  if (windowWidth <= windowHeight && windowWidth < SIDE_PANEL_PORTRAIT_MIN_WIDTH) return undefined;
  const left = (metrics.leftInset ?? 0) + CONTROL_MARGIN;
  const usable = windowWidth - left - (metrics.rightInset ?? 0);
  const preferred = Math.min(
    SIDE_PANEL_MAX_WIDTH,
    Math.max(SIDE_PANEL_MIN_WIDTH, Math.round(windowWidth * 0.4)),
  );
  // On a very small window the map keeps at least 45% of the width.
  return { left, width: Math.min(preferred, Math.round(usable * 0.55)) };
}

/**
 * The horizontal span of the screen the side panel leaves to the map, as distances from the left
 * and right edges. Floating controls, the driving readouts and the camera framing live here. Both
 * are zero in the portrait phone layout, where sheets cover the bottom of the map instead.
 */
export function mapAreaInsets(metrics: ScreenMetrics): { left: number; right: number } {
  const panel = sidePanelFrame(metrics);
  if (panel === undefined) return { left: 0, right: 0 };
  return { left: panel.left + panel.width, right: metrics.rightInset ?? 0 };
}

/** Space the trailing column of floating map buttons takes, including its margins. */
const TRAILING_CONTROLS_WIDTH = 48 + 2 * CONTROL_MARGIN;

export interface SheetDetents {
  /** Index the sheet opens at. */
  initial: number;
  values: number[];
}

function fraction(metrics: ScreenMetrics, value: number): number {
  return Math.round(metrics.windowHeight * value);
}

/**
 * The side panel's two resting heights. A short window (a landscape phone) can make the peek the
 * tallest the panel may be; then it has the one detent.
 */
function peekAndOpen(peek: number, open: number, initial: number): SheetDetents {
  if (open <= peek) return { initial: 0, values: [Math.max(0, open)] };
  return { initial, values: [peek, open] };
}

/** Tallest a sheet may rest: just under the status bar. */
export function fullSheetHeight(metrics: ScreenMetrics, bottomOffset = 0): number {
  return Math.max(0, metrics.windowHeight - metrics.topInset - 8 - bottomOffset);
}

/** The explore sheet sits on the tab bar: search field and category chips at rest. */
export function exploreSheetDetents(metrics: ScreenMetrics): SheetDetents {
  const bottomOffset = TAB_BAR_HEIGHT + metrics.bottomInset;
  if (sidePanelFrame(metrics) !== undefined) {
    return { initial: 0, values: [142, fullSheetHeight(metrics, bottomOffset)] };
  }
  return {
    initial: 0,
    values: [142, fraction(metrics, 0.44), fullSheetHeight(metrics, bottomOffset)],
  };
}

/** Place details: name and actions at rest, details at half, photos and reviews at full. */
export function placeSheetDetents(metrics: ScreenMetrics): SheetDetents {
  if (sidePanelFrame(metrics) !== undefined) {
    // The panel leaves the map beside it, so the place opens with its details showing.
    return peekAndOpen(218 + metrics.bottomInset, fullSheetHeight(metrics), 1);
  }
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
  if (sidePanelFrame(metrics) !== undefined) {
    return peekAndOpen(168 + metrics.bottomInset, fullSheetHeight(metrics), 1);
  }
  const middle = (demoOrigin ? 452 : 388) + metrics.bottomInset;
  return {
    initial: 1,
    values: [168 + metrics.bottomInset, middle, Math.min(fullSheetHeight(metrics), middle + 250)],
  };
}

/** Trip panel: arrival, time, distance and the four driving controls at rest. */
export function tripSheetDetents(metrics: ScreenMetrics): SheetDetents {
  if (sidePanelFrame(metrics) !== undefined) {
    // The maneuver banner tops the same column; the open panel stops under it.
    const underBanner =
      metrics.windowHeight - metrics.topInset - GUIDANCE_BANNER_HEIGHT - CONTROL_MARGIN;
    return peekAndOpen(164 + metrics.bottomInset, underBanner, 0);
  }
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

/** No padding: what MapLibre uses after a camera move that gave none. */
export const NO_CAMERA_PADDING: CameraPadding = { bottom: 0, left: 0, right: 0, top: 0 };

/** Height of the maneuver banner below the status bar, including its gap to the map. */
export const GUIDANCE_BANNER_HEIGHT = 152;

/** Space a safety-camera alert takes under the maneuver banner, including its gap. */
export const CAMERA_ALERT_HEIGHT = 76;

/** Space a reroute offer takes under the maneuver banner, including its gap. */
export const REROUTE_CARD_HEIGHT = 176;

/**
 * Framing for routes and results beside the side panel: clear of the panel, the trailing
 * controls and the system bars. `undefined` in the portrait phone layout.
 */
function sidePanelFraming(metrics: ScreenMetrics, margin: number): CameraPadding | undefined {
  if (sidePanelFrame(metrics) === undefined) return undefined;
  const area = mapAreaInsets(metrics);
  return {
    bottom: metrics.bottomInset + margin,
    left: area.left + margin,
    right: area.right + TRAILING_CONTROLS_WIDTH,
    top: metrics.topInset + margin,
  };
}

/**
 * Padding for the map at rest: the side panel's width on the leading edge, so the location and
 * places centred on the map are centred in the part the panel leaves visible. `undefined` in the
 * portrait phone layout, where the map at rest is not padded.
 */
export function idleCameraPadding(metrics: ScreenMetrics): CameraPadding | undefined {
  if (sidePanelFrame(metrics) === undefined) return undefined;
  const area = mapAreaInsets(metrics);
  return { bottom: 0, left: area.left, right: area.right, top: 0 };
}

/** Padding that frames a previewed route between the top controls and the preview sheet. */
export function routePreviewCameraPadding(
  metrics: ScreenMetrics,
  options: { demoOrigin: boolean },
): CameraPadding {
  const sideFraming = sidePanelFraming(metrics, 40);
  if (sideFraming !== undefined) return sideFraming;
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
  const sideFraming = sidePanelFraming(metrics, 54);
  if (sideFraming !== undefined) return sideFraming;
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
  const area = mapAreaInsets(metrics);
  if (sidePanelFrame(metrics) !== undefined) {
    // Banner and trip panel share the leading column, so the vehicle rides beside them, in the
    // lower part of the map with the road ahead above it.
    const height = metrics.windowHeight - metrics.topInset - metrics.bottomInset;
    return {
      bottom: metrics.bottomInset + 48,
      left: area.left + 24,
      right: area.right + TRAILING_CONTROLS_WIDTH,
      top: metrics.topInset + Math.round(height * 0.35),
    };
  }
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
