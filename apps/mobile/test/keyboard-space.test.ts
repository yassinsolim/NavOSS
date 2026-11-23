import { describe, expect, it } from 'vitest';

import { CROWDED_KEYBOARD_SPACE, isKeyboardCrowded } from '../src/ui/sheet/keyboard-space';

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
