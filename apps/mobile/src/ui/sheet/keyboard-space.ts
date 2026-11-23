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

/** The open keyboard (`height` 0: closed) and the top inset when it opened. */
export interface KeyboardSession {
  height: number;
  topInset: number;
}

export const CLOSED_KEYBOARD: KeyboardSession = { height: 0, topInset: 0 };

/**
 * The session after a keyboard-shown event. The top inset is captured when the keyboard opens and
 * kept while it stays open: crowded mode hides the status bar, and measuring against the inset
 * that leaves would turn crowded mode off again, then on, for as long as the keyboard is up.
 */
export function keyboardShown(
  previous: KeyboardSession,
  height: number,
  currentTopInset: number,
): KeyboardSession {
  return { height, topInset: previous.height > 0 ? previous.topInset : currentTopInset };
}
