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

/** The open keyboard (`height` 0: closed), the width of its window, and whether it is crowded. */
export interface KeyboardSession {
  crowded: boolean;
  height: number;
  windowWidth: number;
}

export const CLOSED_KEYBOARD: KeyboardSession = { crowded: false, height: 0, windowWidth: 0 };

/**
 * The session for the keyboard and window as they are now. Crowded mode holds for as long as the
 * keyboard stays open in a window of the same width: the mode hides the status bar, which changes
 * the top inset and, before Android 15, the reported window height, so measuring again would turn
 * the mode off, then on, for as long as the keyboard is up. A window of another width (a
 * rotation, a resize) is measured afresh, and so is a keyboard that closed and opened again.
 */
export function keyboardSession(
  previous: KeyboardSession,
  current: {
    android: boolean;
    keyboardHeight: number;
    topInset: number;
    windowHeight: number;
    windowWidth: number;
  },
): KeyboardSession {
  if (current.keyboardHeight <= 0) return CLOSED_KEYBOARD;
  const sameWindow = previous.height > 0 && previous.windowWidth === current.windowWidth;
  const crowded = (sameWindow && previous.crowded) || isKeyboardCrowded(current);
  if (sameWindow && previous.crowded === crowded && previous.height === current.keyboardHeight) {
    return previous;
  }
  return { crowded, height: current.keyboardHeight, windowWidth: current.windowWidth };
}
