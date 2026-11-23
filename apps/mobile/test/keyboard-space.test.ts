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
  // Retroid-like window: 393 pt tall, 873 pt wide, 24 pt status bar.
  const open = (
    previous: KeyboardSession,
    keyboardHeight: number,
    topInset: number,
    windowHeight = 393,
    windowWidth = 873,
  ) =>
    keyboardSession(previous, {
      android: true,
      keyboardHeight,
      topInset,
      windowHeight,
      windowWidth,
    });

  it('stays crowded when hiding the status bar drops the inset', () => {
    // 393 - 24 - 150 = 219 pt: crowded. The mode hides the bar: 393 - 0 - 150 = 243 pt.
    const opened = open(CLOSED_KEYBOARD, 150, 24);
    expect(opened.crowded).toBe(true);
    const hidden = open(opened, 150, 0);
    expect(hidden.crowded).toBe(true);
    expect(hidden).toBe(opened);
  });

  it('stays crowded when hiding the status bar grows the reported window, as before Android 15', () => {
    // 393 - 24 - 174 = 195 pt: crowded. Without the bar the window reports 417 pt: 243 pt.
    const opened = open(CLOSED_KEYBOARD, 174, 24);
    expect(opened.crowded).toBe(true);
    expect(open(opened, 174, 0, 417).crowded).toBe(true);
    expect(open(opened, 174, 24, 417).crowded).toBe(true);
  });

  it('is measured afresh once the keyboard closed and opens again', () => {
    const opened = open(CLOSED_KEYBOARD, 150, 24);
    const closed = open(opened, 0, 24);
    expect(closed).toBe(CLOSED_KEYBOARD);
    // A shorter keyboard the next time leaves room: 393 - 24 - 100 = 269 pt.
    expect(open(closed, 100, 24).crowded).toBe(false);
  });

  it('is measured afresh in a window of another width, with the keyboard still open', () => {
    // Landscape crowded, then portrait with plenty of room.
    const landscape = open(CLOSED_KEYBOARD, 150, 24);
    expect(open(landscape, 300, 24, 873, 393).crowded).toBe(false);
    // And the other way: roomy, then a rotation into 500 - 48 - 235 = 217 pt.
    const roomy = open(CLOSED_KEYBOARD, 300, 24, 873, 393);
    expect(roomy.crowded).toBe(false);
    expect(open(roomy, 235, 48, 500, 700).crowded).toBe(true);
  });

  it('becomes crowded when the keyboard grows in the same window', () => {
    const opened = open(CLOSED_KEYBOARD, 100, 24);
    expect(opened.crowded).toBe(false);
    expect(open(opened, 150, 24).crowded).toBe(true);
  });

  it('starts at the boundary: 393 - 24 - 129 = 240 pt is not crowded, 130 pt is', () => {
    expect(open(CLOSED_KEYBOARD, 129, 24).crowded).toBe(false);
    expect(open(CLOSED_KEYBOARD, 130, 24).crowded).toBe(true);
  });

  it('is never crowded on iOS', () => {
    const session = keyboardSession(CLOSED_KEYBOARD, {
      android: false,
      keyboardHeight: 245,
      topInset: 24,
      windowHeight: 393,
      windowWidth: 873,
    });
    expect(session.crowded).toBe(false);
  });
});
