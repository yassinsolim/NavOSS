import { describe, expect, it, vi } from 'vitest';

vi.mock('../modules/navoss-navigation/index.js', () => ({
  default: {
    setHomeDestination: vi.fn(),
    setWorkDestination: vi.fn(),
  },
}));

import NavOSSNavigation from '../modules/navoss-navigation/index.js';
import {
  nativeDestinationToSearchResult,
  setHomeDestination,
  setWorkDestination,
} from '../src/features/navigation/native-navigation.js';

const nativeDestination = {
  category: 'poi' as const,
  id: 'place:1',
  label: 'Office',
  latitude: 51.05,
  longitude: -114.08,
  name: 'Work',
};

describe('saved destination bridge', () => {
  it('converts a native destination to a selectable map place', () => {
    expect(nativeDestinationToSearchResult(nativeDestination)).toEqual({
      category: 'poi',
      center: { latitude: 51.05, longitude: -114.08 },
      confidence: 1,
      id: 'place:1',
      label: 'Office',
      name: 'Work',
    });
  });

  it('defaults older category-less destination records to landmarks', () => {
    const { category: _category, ...legacyDestination } = nativeDestination;
    expect(nativeDestinationToSearchResult(legacyDestination).category).toBe('landmark');
  });

  it('sets and clears Home and Work using native records', () => {
    const place = nativeDestinationToSearchResult(nativeDestination);

    setHomeDestination(place);
    setWorkDestination(undefined);

    expect(NavOSSNavigation.setHomeDestination).toHaveBeenCalledWith(nativeDestination);
    expect(NavOSSNavigation.setWorkDestination).toHaveBeenCalledWith(null);
  });
});
