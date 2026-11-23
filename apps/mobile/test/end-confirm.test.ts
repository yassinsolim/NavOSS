import { describe, expect, it } from 'vitest';

import { END_CONFIRM_MS, endPress } from '../src/features/navigation/end-confirm.js';

describe('endPress', () => {
  it('ends at once on a touch, on every platform', () => {
    expect(endPress({ armedAt: undefined, keyActivated: false, now: 0, platform: 'android' })).toBe(
      'end',
    );
    expect(endPress({ armedAt: undefined, keyActivated: true, now: 0, platform: 'ios' })).toBe(
      'end',
    );
  });

  it('asks for a second key press on Android before ending', () => {
    expect(
      endPress({ armedAt: undefined, keyActivated: true, now: 1000, platform: 'android' }),
    ).toBe('arm');
    expect(endPress({ armedAt: 1000, keyActivated: true, now: 2500, platform: 'android' })).toBe(
      'end',
    );
  });

  it('forgets the first key press after the confirmation window', () => {
    expect(
      endPress({
        armedAt: 1000,
        keyActivated: true,
        now: 1000 + END_CONFIRM_MS + 1,
        platform: 'android',
      }),
    ).toBe('arm');
  });
});
