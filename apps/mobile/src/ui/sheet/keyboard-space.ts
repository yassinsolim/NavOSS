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

/** The open keyboard (`height` 0: closed), the window it is open in, and that window's top inset. */
export interface KeyboardSession {
  height: number;
  topInset: number;
  windowHeight: number;
  windowWidth: number;
}

export const CLOSED_KEYBOARD: KeyboardSession = {
  height: 0,
  topInset: 0,
  windowHeight: 0,
  windowWidth: 0,
};

/**
 * The session for the keyboard and window as they are now. While the keyboard stays open in the
 * same window, the top inset is the greatest seen: crowded mode hides the status bar, and
 * measuring against the inset that leaves would turn crowded mode off again, then on, for as long
 * as the keyboard is up. A window of another size (a rotation, a resize) starts over with its own
 * inset, and so does a keyboard that closed and opened again.
 */
export function keyboardSession(
  previous: KeyboardSession,
  current: KeyboardSession,
): KeyboardSession {
  if (current.height <= 0) return CLOSED_KEYBOARD;
  const sameWindow =
    previous.height > 0 &&
    previous.windowHeight === current.windowHeight &&
    previous.windowWidth === current.windowWidth;
  const topInset = sameWindow ? Math.max(previous.topInset, current.topInset) : current.topInset;
  if (sameWindow && previous.height === current.height && previous.topInset === topInset) {
    return previous;
  }
  return { ...current, topInset };
}
