import { describe, expect, it, vi } from 'vitest';

import {
  createAutomaticLocationPermission,
  ensureForegroundLocationPermission,
  mapLocationPermissionRequest,
} from '../src/features/map/map-location.js';

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

describe('automatic map location permission', () => {
  it('shows the system prompt at most once when the map becomes visible again', async () => {
    // Android pauses the app behind the permission dialog, so the map becomes visible again as
    // soon as the driver answers; a denial there must not reopen the dialog.
    const getPermission = vi.fn(() => Promise.resolve({ canAskAgain: true, granted: false }));
    const requestPermission = vi.fn(() => Promise.resolve({ canAskAgain: true, granted: false }));
    const automatic = createAutomaticLocationPermission(getPermission, requestPermission);

    expect(await automatic()).toBe(false);
    expect(await automatic()).toBe(false);
    expect(requestPermission).toHaveBeenCalledOnce();
  });

  it('still sees a grant made later in Settings', async () => {
    const getPermission = vi
      .fn()
      .mockResolvedValueOnce({ canAskAgain: true, granted: false })
      .mockResolvedValue({ canAskAgain: true, granted: true });
    const requestPermission = vi.fn(() => Promise.resolve({ canAskAgain: true, granted: false }));
    const automatic = createAutomaticLocationPermission(getPermission, requestPermission);

    expect(await automatic()).toBe(false);
    expect(await automatic()).toBe(true);
    expect(requestPermission).toHaveBeenCalledOnce();
  });
});

describe('the map first-fix permission request per platform', () => {
  const denied = () => Promise.resolve({ canAskAgain: true, granted: false });

  it('asks every time on iOS, as before Android support (an expired one-time grant)', async () => {
    const requestPermission = vi.fn(denied);
    const automatic = mapLocationPermissionRequest(false, denied, requestPermission);

    expect(await automatic()).toBe(false);
    expect(await automatic()).toBe(false);
    expect(requestPermission).toHaveBeenCalledTimes(2);
    // Parity with the helper iOS used before: the same calls for the same answers.
    const direct = vi.fn(denied);
    await ensureForegroundLocationPermission(denied, direct);
    await ensureForegroundLocationPermission(denied, direct);
    expect(direct).toHaveBeenCalledTimes(requestPermission.mock.calls.length);
  });

  it('asks once per session on Android', async () => {
    const requestPermission = vi.fn(denied);
    const automatic = mapLocationPermissionRequest(true, denied, requestPermission);

    await automatic();
    await automatic();
    expect(requestPermission).toHaveBeenCalledOnce();
  });
});
