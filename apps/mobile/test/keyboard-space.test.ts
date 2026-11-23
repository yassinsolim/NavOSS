import { describe, expect, it } from 'vitest';

import {
  CLOSED_KEYBOARD,
  CROWDED_KEYBOARD_SPACE,
  isKeyboardCrowded,
  keyboardSession,
  type KeyboardSession,
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

describe('keyboardSession', () => {
  // 393 pt window, 150 pt keyboard, 24 pt status bar: 219 pt left, crowded. Crowded mode hides the
  // status bar, so the live inset drops to 0 (243 pt left, not crowded) and would flip back.
  const window = { windowHeight: 393, windowWidth: 873 };
  const crowded = (session: KeyboardSession) =>
    isKeyboardCrowded({
      android: true,
      keyboardHeight: session.height,
      topInset: session.topInset,
      windowHeight: session.windowHeight,
    });

  it('keeps the greatest inset seen while the keyboard stays open in the same window', () => {
    const opened = keyboardSession(CLOSED_KEYBOARD, { ...window, height: 150, topInset: 24 });
    expect(crowded(opened)).toBe(true);
    // The status bar hid (inset 0).
    const hidden = keyboardSession(opened, { ...window, height: 150, topInset: 0 });
    expect(hidden.topInset).toBe(24);
    expect(crowded(hidden)).toBe(true);
    expect(hidden).toBe(opened);
  });

  it('starts over once the keyboard closed and opens again', () => {
    const opened = keyboardSession(CLOSED_KEYBOARD, { ...window, height: 150, topInset: 24 });
    const closed = keyboardSession(opened, { ...window, height: 0, topInset: 24 });
    expect(closed).toBe(CLOSED_KEYBOARD);
    expect(keyboardSession(closed, { ...window, height: 150, topInset: 0 }).topInset).toBe(0);
  });

  it("takes the new window's inset after a rotation with the keyboard still open", () => {
    // 500 pt window, 235 pt keyboard: with the old 24 pt inset 241 pt would be left (not
    // crowded); the new window's inset is 48 pt, which leaves 217 pt.
    const before = keyboardSession(CLOSED_KEYBOARD, { ...window, height: 150, topInset: 24 });
    const rotated = { windowHeight: 500, windowWidth: 700 };
    const after = keyboardSession(before, { ...rotated, height: 235, topInset: 48 });
    expect(after.topInset).toBe(48);
    expect(crowded(after)).toBe(true);
    // Crowded mode then hides the status bar there too; the mode holds.
    expect(crowded(keyboardSession(after, { ...rotated, height: 235, topInset: 0 }))).toBe(true);
  });

  it('follows an inset that grows in the same window', () => {
    const opened = keyboardSession(CLOSED_KEYBOARD, { ...window, height: 150, topInset: 0 });
    expect(keyboardSession(opened, { ...window, height: 150, topInset: 24 }).topInset).toBe(24);
  });

  it('stays at the boundary: 393 - 24 - 129 = 240 pt is not crowded, 130 pt is', () => {
    const at = (height: number) =>
      crowded(keyboardSession(CLOSED_KEYBOARD, { ...window, height, topInset: 24 }));
    expect(at(129)).toBe(false);
    expect(at(130)).toBe(true);
  });
});
