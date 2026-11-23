import { beforeEach, describe, expect, it, vi } from 'vitest';

const nativeModule = vi.hoisted(() => ({
  addListener: vi.fn<
    (event: string, listener: (payload: unknown) => void) => { remove: () => void }
  >(() => ({ remove: vi.fn() })),
  getCapabilities: vi.fn(() => ({ version: 10 })),
}));

vi.mock('../modules/navoss-navigation/index.js', () => ({ default: nativeModule }));

import {
  nativeNavigationContractError,
  nativeSnapshot,
  observeNavigationSnapshots,
  REQUIRED_NATIVE_NAVIGATION_VERSION,
  UNAVAILABLE_SNAPSHOT,
} from '../src/features/navigation/native-navigation.js';

describe('native navigation contract gate', () => {
  beforeEach(() => {
    nativeModule.addListener.mockClear();
  });

  it('accepts the required contract and newer ones', () => {
    expect(nativeNavigationContractError(REQUIRED_NATIVE_NAVIGATION_VERSION)).toBeUndefined();
    expect(nativeNavigationContractError(REQUIRED_NATIVE_NAVIGATION_VERSION + 1)).toBeUndefined();
  });

  it('names the mismatch and the fix for an older dev client', () => {
    expect(nativeNavigationContractError(10)).toMatch(
      /contract v10, but this JavaScript needs v11\. Rebuild the iOS dev client/,
    );
    expect(nativeNavigationContractError(undefined)).toMatch(/contract unknown/);
  });

  it('fails loudly instead of subscribing to a v10 binary', () => {
    expect(() => observeNavigationSnapshots(() => undefined)).toThrow(/Rebuild the iOS dev client/);
    expect(nativeModule.addListener).not.toHaveBeenCalled();
  });

  it('subscribes once the binary matches', () => {
    nativeModule.getCapabilities.mockReturnValue({ version: 11 });
    observeNavigationSnapshots(() => undefined);
    expect(nativeModule.addListener).toHaveBeenCalledWith(
      'onNavigationSnapshot',
      expect.any(Function),
    );
  });
});

describe('snapshot payloads', () => {
  const snapshot = {
    isOffRoute: false,
    phase: 'tracking' as const,
    rerouteCount: 0,
    routeProgress: 0.5,
    routeStatus: 'tracking' as const,
    routeVersion: 1,
    sequence: 3,
    stateVersion: 7,
  };

  it('keeps the object iOS hands over', () => {
    expect(nativeSnapshot(snapshot)).toBe(snapshot);
  });

  it("parses the Android core's JSON text once, value for value", () => {
    expect(nativeSnapshot({ snapshotJson: JSON.stringify(snapshot) })).toEqual(snapshot);
  });

  it('treats malformed Android snapshot text as guidance unavailable', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    for (const text of [
      'not json',
      'null',
      JSON.stringify({ ...snapshot, phase: 'flying' }),
      JSON.stringify({ ...snapshot, stateVersion: '7' }),
      JSON.stringify({ ...snapshot, routeStatus: undefined }),
      JSON.stringify({ ...snapshot, trip: { id: 1, steps: [] } }),
    ]) {
      expect(nativeSnapshot({ snapshotJson: text })).toBe(UNAVAILABLE_SNAPSHOT);
    }
    expect(UNAVAILABLE_SNAPSHOT.stateVersion).toBeLessThan(0);
    expect(UNAVAILABLE_SNAPSHOT.trip).toBeUndefined();
    warn.mockRestore();
  });

  it("accepts the fix's course off the route, and a snapshot from a core without it", () => {
    const offRoute = { ...snapshot, isOffRoute: true, rawCourseDegrees: 270 };
    expect(nativeSnapshot({ snapshotJson: JSON.stringify(offRoute) })).toEqual(offRoute);
    expect(
      nativeSnapshot({ snapshotJson: JSON.stringify({ ...offRoute, rawCourseDegrees: 0 }) }),
    ).toMatchObject({ rawCourseDegrees: 0 });
    const older = nativeSnapshot({ snapshotJson: JSON.stringify(snapshot) });
    expect(older).toEqual(snapshot);
    expect(older.rawCourseDegrees).toBeUndefined();
  });

  it('treats a course that is not a bearing as a malformed snapshot', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    for (const rawCourseDegrees of [-1, 360, 720, '270', null, true]) {
      expect(
        nativeSnapshot({ snapshotJson: JSON.stringify({ ...snapshot, rawCourseDegrees }) }),
      ).toBe(UNAVAILABLE_SNAPSHOT);
    }
    warn.mockRestore();
  });

  it('delivers parsed snapshots to listeners', () => {
    nativeModule.getCapabilities.mockReturnValue({ version: 11 });
    const received: unknown[] = [];
    observeNavigationSnapshots((next) => received.push(next));
    const forward = nativeModule.addListener.mock.calls.at(-1)?.[1] as unknown as (
      payload: unknown,
    ) => void;
    forward({ snapshotJson: JSON.stringify(snapshot) });
    expect(received).toEqual([snapshot]);
  });
});
