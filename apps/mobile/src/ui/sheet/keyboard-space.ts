/**
 * Least height (pt) a sheet needs between the status bar and the keyboard to show its header,
 * a search field and results. Below it, a search sheet drops everything but the field and the
 * results while the keyboard is up.
 */
export const CROWDED_KEYBOARD_SPACE = 240;

/**
 * Whether the on-screen keyboard leaves too little room above it for a search sheet's chrome: a
 * landscape handheld (Gboard covers about 60% of a 1080p landscape screen) or a phone held
 * sideways. Android only; the iOS build is portrait and keeps its layout.
 */
export function isKeyboardCrowded({
  android,
  keyboardHeight,
  topInset,
  windowHeight,
}: {
  android: boolean;
  keyboardHeight: number;
  topInset: number;
  windowHeight: number;
}): boolean {
  if (!android || keyboardHeight <= 0) return false;
  return windowHeight - topInset - keyboardHeight < CROWDED_KEYBOARD_SPACE;
}
