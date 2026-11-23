/**
 * Props that keep a pressable out of D-pad focus, for one it hides (a row below a collapsed
 * sheet's edge) or a surface that is not a control (a modal's scrim). On Android React Native's
 * `focusable={false}` alone does not do it: `accessible`, true by default on a pressable, makes the
 * view focusable again, and `accessible={false}` alone loses to the `focusable` a pressable sends,
 * so both are off. A hidden view leaves TalkBack too; its texts would otherwise become separate
 * elements. Nothing changes on iOS.
 */
export function hiddenFromFocusProps(platform: string): {
  accessible?: false;
  focusable?: false;
  importantForAccessibility?: 'no-hide-descendants';
} {
  return platform === 'android'
    ? { accessible: false, focusable: false, importantForAccessibility: 'no-hide-descendants' }
    : {};
}

/**
 * Props for a readout TalkBack reads as one element but that is not a control (speed, trip
 * status, the maneuver banner). On Android `accessible` makes a view a D-pad focus stop that does
 * nothing when pressed, and `focusable={false}` never takes that back (React Native's view manager
 * leaves focusability alone for it), so `accessible` is turned off and the view stays one TalkBack
 * element through `screenReaderFocusable` (Android 9 and later; older versions read the texts
 * one by one). Spread after `accessible`. Nothing changes on iOS.
 */
export function readoutFocusProps(platform: string): {
  accessible?: false;
  screenReaderFocusable?: true;
} {
  return platform === 'android' ? { accessible: false, screenReaderFocusable: true } : {};
}

/**
 * Whether a control asks for keyboard focus (`useKeyFocus`): on Android, when it mounts with a
 * key or its key changes (a sheet opened or changed what it shows). The native side then gives it
 * focus only while the driver is using keys, never after a touch.
 */
export function keyFocusRequested(
  platform: string,
  previous: string | undefined,
  next: string | undefined,
): boolean {
  return platform === 'android' && next !== undefined && next !== previous;
}

/**
 * Whether a focused control draws its ring. A control under an open modal sheet keeps Android's
 * focus in its own window while the sheet has the keys, so its ring would be stale: only the top
 * layer (`layer` = the number of modal sheets the control sits in) draws one.
 */
export function focusRingVisible({
  focused,
  layer,
  openModals,
}: {
  focused: boolean;
  layer: number;
  openModals: number;
}): boolean {
  return focused && layer >= openModals;
}
