import { describe, expect, it } from 'vitest';

import {
  CLOSED_KEYBOARD,
  CROWDED_KEYBOARD_SPACE,
  isKeyboardCrowded,
  keyboardShown,
} from '../src/ui/sheet/keyboard-space';

describe('isKeyboardCrowded', () => {
  // Retroid-like handheld: 1920x1080 at 440 dpi is 393 pt tall; Gboard in landscape is 245 pt.
  const landscape = { keyboardHeight: 245, topInset: 24, windowHeight: 393 };

  it('is crowded when an Android keyboard leaves less than the limit above it', () => {
    expect(isKeyboardCrowded({ ...landscape, android: true })).toBe(true);
  });

  it('is never crowded on iOS, whatever the window', () => {
    expect(isKeyboardCrowded({ ...landscape, android: false })).toBe(false);
  });

  it('is not crowded without a keyboard', () => {
    expect(isKeyboardCrowded({ ...landscape, android: true, keyboardHeight: 0 })).toBe(false);
  });

  it('is not crowded in a portrait phone window', () => {
    expect(
      isKeyboardCrowded({ android: true, keyboardHeight: 300, topInset: 24, windowHeight: 800 }),
    ).toBe(false);
  });

  it('starts at the limit', () => {
    const windowHeight = 24 + 245 + CROWDED_KEYBOARD_SPACE;
    expect(isKeyboardCrowded({ ...landscape, android: true, windowHeight })).toBe(false);
    expect(isKeyboardCrowded({ ...landscape, android: true, windowHeight: windowHeight - 1 })).toBe(
      true,
    );
  });
});

describe('keyboardShown', () => {
  // 393 pt window, 150 pt keyboard, 24 pt status bar: 219 pt left, crowded. Crowded mode hides the
  // status bar, so the live inset drops to 0 (243 pt left, not crowded) and would flip back.
  const crowdedAt = (session: { height: number; topInset: number }) =>
    isKeyboardCrowded({
      android: true,
      keyboardHeight: session.height,
      topInset: session.topInset,
      windowHeight: 393,
    });

  it('keeps the inset captured when the keyboard opened while it stays open', () => {
    const opened = keyboardShown(CLOSED_KEYBOARD, 150, 24);
    expect(crowdedAt(opened)).toBe(true);
    // The status bar hid (inset 0) and the keyboard reported its height again.
    const again = keyboardShown(opened, 150, 0);
    expect(again.topInset).toBe(24);
    expect(crowdedAt(again)).toBe(true);
  });

  it('captures the inset afresh once the keyboard closed and opens again', () => {
    expect(keyboardShown(CLOSED_KEYBOARD, 150, 0)).toEqual({ height: 150, topInset: 0 });
  });

  it('stays at the boundary: 393 - 24 - 129 = 240 pt is not crowded, 130 pt is', () => {
    expect(crowdedAt(keyboardShown(CLOSED_KEYBOARD, 129, 24))).toBe(false);
    expect(crowdedAt(keyboardShown(CLOSED_KEYBOARD, 130, 24))).toBe(true);
  });
});
