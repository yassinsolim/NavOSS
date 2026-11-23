import { describe, expect, it } from 'vitest';

import {
  focusRingVisible,
  hiddenFromFocusProps,
  keyFocusRequested,
  readoutFocusProps,
  resultFocusKey,
} from '../src/ui/focus.js';

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

describe('readoutFocusProps', () => {
  it('keeps a spoken readout out of D-pad focus on Android, as one TalkBack element', () => {
    // `focusable={false}` cannot do it: React Native's view manager never clears focusability
    // for it, and `accessible` sets it.
    expect(readoutFocusProps('android')).toEqual({
      accessible: false,
      screenReaderFocusable: true,
    });
  });

  it('changes nothing on iOS', () => {
    expect(readoutFocusProps('ios')).toEqual({});
  });
});

describe('keyFocusRequested', () => {
  it('asks on Android when a control mounts with a key or its key changes', () => {
    expect(keyFocusRequested('android', undefined, 'place:1')).toBe(true);
    expect(keyFocusRequested('android', 'place:1', 'place:2')).toBe(true);
  });

  it('does not ask again for the same key, without a key, or on iOS', () => {
    expect(keyFocusRequested('android', 'place:1', 'place:1')).toBe(false);
    expect(keyFocusRequested('android', 'place:1', undefined)).toBe(false);
    expect(keyFocusRequested('ios', undefined, 'place:1')).toBe(false);
  });
});

describe('focusRingVisible', () => {
  it('draws the ring of a focused control on the top layer', () => {
    expect(focusRingVisible({ focused: true, layer: 0, openModals: 0 })).toBe(true);
    expect(focusRingVisible({ focused: true, layer: 1, openModals: 1 })).toBe(true);
  });

  it('hides the ring a control keeps under an open modal sheet', () => {
    expect(focusRingVisible({ focused: true, layer: 0, openModals: 1 })).toBe(false);
    expect(focusRingVisible({ focused: true, layer: 1, openModals: 2 })).toBe(false);
  });

  it('draws nothing for an unfocused control', () => {
    expect(focusRingVisible({ focused: false, layer: 0, openModals: 0 })).toBe(false);
  });
});

describe('resultFocusKey', () => {
  it('never moves focus while the search field is being edited', () => {
    expect(
      resultFocusKey({ fieldFocused: true, query: 'Calgary', submittedQuery: undefined }),
    ).toBeUndefined();
    // Editing after a submit: the submitted query no longer matches.
    expect(
      resultFocusKey({ fieldFocused: true, query: 'Calgary T', submittedQuery: 'Calgary' }),
    ).toBeUndefined();
  });

  it('hands focus to the results after a submit, or once the field has no focus', () => {
    expect(
      resultFocusKey({ fieldFocused: true, query: 'Calgary', submittedQuery: 'Calgary' }),
    ).toBe('results:Calgary');
    expect(
      resultFocusKey({ fieldFocused: false, query: 'Calgary', submittedQuery: undefined }),
    ).toBe('results:Calgary');
  });
});
