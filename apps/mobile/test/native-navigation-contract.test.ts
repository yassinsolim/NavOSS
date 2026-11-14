import { beforeEach, describe, expect, it, vi } from 'vitest';

const nativeModule = vi.hoisted(() => ({
  addListener: vi.fn(() => ({ remove: vi.fn() })),
  getCapabilities: vi.fn(() => ({ version: 10 })),
}));

vi.mock('../modules/navoss-navigation/index.js', () => ({ default: nativeModule }));

import {
  nativeNavigationContractError,
  observeNavigationSnapshots,
  REQUIRED_NATIVE_NAVIGATION_VERSION,
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
