import { describe, expect, it, vi } from 'vitest';

vi.mock('../modules/navoss-navigation/index.js', () => ({ default: {} }));

import type { NativeNavigationDestination } from '../modules/navoss-navigation/index.js';
import { savedRouteStarts } from '../src/features/navigation/route-start.js';

function place(id: string, name = id): NativeNavigationDestination {
  return { id, label: `${name}, Calgary`, latitude: 51, longitude: -114, name };
}

describe('saved places offered as a route start', () => {
  it('lists Home, Work, favourites and recents once each, in that order', () => {
    const starts = savedRouteStarts(
      {
        favorites: [place('cafe'), place('home')],
        home: place('home', 'Home street'),
        recents: [place('gym'), place('cafe'), place('work')],
        work: place('work', 'Office'),
      },
      'airport',
    );
    expect(starts.map((start) => [start.kind, start.place.id])).toEqual([
      ['Home', 'home'],
      ['Work', 'work'],
      ['Saved', 'cafe'],
      ['Recent', 'gym'],
    ]);
    expect(starts[0]?.place.center).toEqual({ latitude: 51, longitude: -114 });
  });

  it('never offers the destination itself, which the routing service cannot route to', () => {
    const starts = savedRouteStarts(
      { favorites: [place('tower')], home: place('tower'), recents: [place('tower')] },
      'tower',
    );
    expect(starts).toEqual([]);
  });
});
