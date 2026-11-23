import { describe, expect, it } from 'vitest';

import { hiddenFromFocusProps } from '../src/ui/focus.js';

describe('hiddenFromFocusProps', () => {
  it('turns accessible and focusable off on Android: either one left on makes the view focusable', () => {
    expect(hiddenFromFocusProps('android')).toEqual({
      accessible: false,
      focusable: false,
      importantForAccessibility: 'no-hide-descendants',
    });
  });

  it('changes nothing on iOS', () => {
    expect(hiddenFromFocusProps('ios')).toEqual({});
  });
});
