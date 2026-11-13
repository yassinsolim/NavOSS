import type { RouteRequest, SearchResult } from '@navoss/contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../modules/navoss-navigation/index.js', () => ({
  default: {
    addListener: vi.fn(() => ({ remove: vi.fn() })),
    getOfflineState: vi.fn(),
    planOfflineRoutes: vi.fn(),
    searchOffline: vi.fn(),
  },
}));

import NavOSSNavigation, {
  type NativeCarPlayTrip,
  type NativeOfflineState,
} from '../modules/navoss-navigation/index.js';
import {
  fetchRoutesWithOfflineFallback,
  isUnreachable,
  searchPlacesWithOfflineFallback,
} from '../src/features/offline/offline-maps.js';
import { NavOssApiError } from '../src/lib/api.js';

const installed: NativeOfflineState = {
  catalog: 'available',
  networkAvailable: true,
  preferOffline: false,
  regions: [
    {
      attribution: [],
      bounds: [-114.9, 50.4, -113.1, 51.6],
      downloadBytes: 0,
      id: 'calgary',
      installedBytes: 389_000_000,
      installedVersion: '2026-11-11-v1-798f5c442644',
      name: 'Calgary',
      state: 'installed',
      updateAvailable: false,
    },
  ],
  stale: false,
  storageBytes: 389_000_000,
};

const request: RouteRequest = {
  alternatives: 2,
  destination: { latitude: 51.0866, longitude: -114.1305 },
  origin: { latitude: 51.0447, longitude: -114.0719 },
  preferences: {
    avoidFerries: false,
    avoidHighways: false,
    avoidTolls: false,
    avoidUnpaved: false,
  },
};

const destination: SearchResult = {
  category: 'poi',
  center: request.destination,
  confidence: 1,
  id: 'nominatim:way:1',
  label: 'Somewhere',
  name: 'Somewhere',
};

function trip(id: string, durationSeconds: number): NativeCarPlayTrip {
  return {
    destination: {
      id: destination.id,
      label: destination.label,
      latitude: request.destination.latitude,
      longitude: request.destination.longitude,
      name: destination.name,
    },
    distanceMeters: 9_049,
    durationSeconds,
    geometry: [request.origin, request.destination],
    id,
    preferences: request.preferences,
    source: 'offline-valhalla',
    steps: [
      {
        distanceMeters: 9_049,
        durationSeconds,
        geometry: [request.origin, request.destination],
        instruction: 'Drive west.',
        maneuverType: 'depart',
        roadName: '',
      },
    ],
  };
}

const unreachable = () => Promise.reject(new TypeError('Network request failed'));

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('offline fallback', () => {
  beforeEach(() => {
    // The development API fallback; release builds configure EXPO_PUBLIC_API_URL instead.
    vi.stubGlobal('__DEV__', true);
    vi.mocked(NavOSSNavigation.getOfflineState).mockReturnValue(installed);
    vi.mocked(NavOSSNavigation.planOfflineRoutes).mockReset();
    vi.mocked(NavOSSNavigation.searchOffline).mockReset();
  });

  it('treats transport failures and 5xx as unreachable, never a rejected request', () => {
    expect(isUnreachable(new TypeError('Network request failed'))).toBe(true);
    expect(isUnreachable(new NavOssApiError('down', 503))).toBe(true);
    expect(isUnreachable(new NavOssApiError('bad', 400))).toBe(false);
    expect(isUnreachable(new Error('other'))).toBe(false);
  });

  it('answers with labelled offline routes when the service is unreachable', async () => {
    vi.mocked(NavOSSNavigation.planOfflineRoutes).mockResolvedValue({
      ok: true,
      trips: [trip('offline-1', 930), trip('offline-2', 900)],
    });
    vi.stubGlobal('fetch', vi.fn(unreachable));
    const planned = await fetchRoutesWithOfflineFallback(request, destination, []);
    expect(planned.source.id).toBe('offline-valhalla');
    expect(planned.source.attribution).toBe('Offline route · No traffic or closures');
    expect(planned.routes.map((route) => route.label)).toEqual(['alternative', 'fastest']);
    expect(planned.routes[0]?.geometry[0]).toEqual([-114.0719, 51.0447]);
  });

  it('explains a trip outside downloaded regions instead of inventing a route', async () => {
    vi.mocked(NavOSSNavigation.planOfflineRoutes).mockResolvedValue({
      code: 'outside-coverage',
      ok: false,
    });
    vi.stubGlobal('fetch', vi.fn(unreachable));
    await expect(fetchRoutesWithOfflineFallback(request, destination, [])).rejects.toThrow(
      'this trip leaves your downloaded offline maps',
    );
  });

  it('goes straight to offline without a network, and stays online-only without regions', async () => {
    vi.mocked(NavOSSNavigation.getOfflineState).mockReturnValue({
      ...installed,
      networkAvailable: false,
    });
    vi.mocked(NavOSSNavigation.planOfflineRoutes).mockResolvedValue({
      ok: true,
      trips: [trip('offline-1', 930)],
    });
    const fetchSpy = vi.fn(unreachable);
    vi.stubGlobal('fetch', fetchSpy);
    await fetchRoutesWithOfflineFallback(request, destination, []);
    expect(fetchSpy).not.toHaveBeenCalled();

    vi.mocked(NavOSSNavigation.getOfflineState).mockReturnValue({ ...installed, regions: [] });
    await expect(fetchRoutesWithOfflineFallback(request, destination, [])).rejects.toThrow(
      'Network request failed',
    );
  });

  it('labels offline search results with the data date', async () => {
    vi.mocked(NavOSSNavigation.searchOffline).mockResolvedValue({
      bundleVersion: '2026-11-11-v1-798f5c442644',
      ok: true,
      osmTimestamp: '2026-11-11T21:22:47Z',
      results: [
        {
          address: '101 9 Avenue SE Calgary T2P 1J9',
          category: 'poi',
          detailCategory: 'attraction',
          distanceMeters: 120,
          id: 'nominatim:way:25719793',
          label: '101 9 Avenue SE Calgary T2P 1J9',
          latitude: 51.0443,
          longitude: -114.0631,
          name: 'Calgary Tower',
          nameSource: 'osm',
        },
      ],
    });
    vi.stubGlobal('fetch', vi.fn(unreachable));
    const response = await searchPlacesWithOfflineFallback('calgary tower', {
      latitude: 51.04,
      longitude: -114.06,
    });
    expect(response.source).toEqual({
      datasetVersion: '2026-11-11-v1-798f5c442644',
      freshness: 'static',
      id: 'offline-osm',
      updatedAt: '2026-11-11T21:22:47Z',
    });
    expect(response.results[0]).toMatchObject({
      details: { address: '101 9 Avenue SE Calgary T2P 1J9', category: 'attraction' },
      id: 'nominatim:way:25719793',
      name: 'Calgary Tower',
    });
    expect(NavOSSNavigation.searchOffline).toHaveBeenCalledWith(
      'calgary tower',
      51.04,
      -114.06,
      8,
      null,
    );
  });
});
