import { describe, expect, it } from 'vitest';

import {
  exploreServiceNotice,
  mapProblemLabels,
  searchSourceLabel,
} from '../src/features/map/search-status.js';

const healthy = {
  apiConnection: 'online',
  locationState: 'visible',
  nearbySearchEnabled: true,
} as const;

describe('explore service notice', () => {
  it('says nothing when the service, location and coverage are all available', () => {
    expect(exploreServiceNotice(healthy)).toBeUndefined();
  });

  it('reports the most blocking problem first', () => {
    expect(
      exploreServiceNotice({ ...healthy, apiConnection: 'offline', locationState: 'denied' })
        ?.title,
    ).toBe('Service unavailable');
    expect(exploreServiceNotice({ ...healthy, locationState: 'denied' })?.title).toBe(
      'Location access is off',
    );
    expect(exploreServiceNotice({ ...healthy, locationState: 'error' })?.title).toBe(
      'Current location unavailable',
    );
    expect(exploreServiceNotice({ ...healthy, apiConnection: 'connecting' })?.title).toBe(
      'Connecting',
    );
  });

  it('explains missing coverage only once a location is known', () => {
    expect(exploreServiceNotice({ ...healthy, nearbySearchEnabled: false })?.title).toBe(
      'Outside current coverage',
    );
    expect(
      exploreServiceNotice({ ...healthy, locationState: 'locating', nearbySearchEnabled: false }),
    ).toBeUndefined();
  });
});

describe('map problem labels', () => {
  const clear = {
    apiConnection: 'online',
    locationState: 'visible',
    mapError: false,
    routeIsIdle: true,
  } as const;

  it('pins nothing to a healthy map', () => {
    expect(mapProblemLabels(clear)).toEqual([]);
  });

  it('lists every problem that is true at once', () => {
    expect(
      mapProblemLabels({
        apiConnection: 'offline',
        locationState: 'denied',
        mapError: true,
        routeIsIdle: true,
      }),
    ).toEqual(['Basemap unavailable', 'Service unavailable', 'Location access is off']);
  });

  it('leaves location problems to the route sheet once a route is being planned', () => {
    expect(mapProblemLabels({ ...clear, locationState: 'error', routeIsIdle: false })).toEqual([]);
    expect(mapProblemLabels({ ...clear, locationState: 'error' })).toEqual([
      'Current location unavailable',
    ]);
  });
});

describe('search source label', () => {
  const source = { datasetVersion: '1', updatedAt: '2026-01-01T00:00:00Z' };

  it('never presents static or preview data as live', () => {
    expect(searchSourceLabel(undefined)).toBe('Place search');
    expect(searchSourceLabel({ ...source, freshness: 'static', id: 'calgary-fixtures' })).toBe(
      'Calgary place data · Not live',
    );
    expect(searchSourceLabel({ ...source, freshness: 'fresh', id: 'photon-development' })).toBe(
      'OpenStreetMap search · Preview data',
    );
    expect(searchSourceLabel({ ...source, freshness: 'fresh', id: 'nominatim-self-hosted' })).toBe(
      'OpenStreetMap search',
    );
    expect(
      searchSourceLabel({ ...source, freshness: 'fresh', id: 'nominatim-self-hosted' }, true),
    ).toBe('OpenStreetMap search · Some sources unavailable, results may be incomplete');
    expect(searchSourceLabel({ ...source, freshness: 'fresh', id: 'calgary-hybrid-search' })).toBe(
      'Calgary Open Data + OpenStreetMap',
    );
  });

  it('does not call a functioning development provider unavailable', () => {
    expect(
      searchSourceLabel({ ...source, freshness: 'fresh', id: 'photon-development' }, true),
    ).toBe('OpenStreetMap search · Preview data · Results may be incomplete');
  });

  it('keeps regional empty-fixture status free of a Calgary coverage claim', () => {
    expect(
      searchSourceLabel({ ...source, freshness: 'static', id: 'regional-empty-fixtures' }),
    ).toBe('Place data · Not live');
  });
});
