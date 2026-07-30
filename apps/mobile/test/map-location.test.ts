import { describe, expect, it, vi } from 'vitest';

import { ensureForegroundLocationPermission } from '../src/features/map/map-location.js';

describe('foreground map location permission', () => {
  it('uses an existing grant without prompting again', async () => {
    const requestPermission = vi.fn();

    expect(
      await ensureForegroundLocationPermission(
        () => Promise.resolve({ canAskAgain: true, granted: true }),
        requestPermission,
      ),
    ).toBe(true);
    expect(requestPermission).not.toHaveBeenCalled();
  });

  it('requests an undetermined permission automatically', async () => {
    const requestPermission = vi.fn(() => Promise.resolve({ canAskAgain: true, granted: true }));

    expect(
      await ensureForegroundLocationPermission(
        () => Promise.resolve({ canAskAgain: true, granted: false }),
        requestPermission,
      ),
    ).toBe(true);
    expect(requestPermission).toHaveBeenCalledOnce();
  });

  it('does not reprompt when the operating system blocks another request', async () => {
    const requestPermission = vi.fn();

    expect(
      await ensureForegroundLocationPermission(
        () => Promise.resolve({ canAskAgain: false, granted: false }),
        requestPermission,
      ),
    ).toBe(false);
    expect(requestPermission).not.toHaveBeenCalled();
  });
});
