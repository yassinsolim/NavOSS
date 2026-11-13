import { describe, expect, it, vi } from 'vitest';

vi.mock('../modules/navoss-navigation/index.js', () => ({ default: {} }));

import type {
  NativeOfflineRegion,
  NativeOfflineState,
} from '../modules/navoss-navigation/index.js';
import { searchSourceLabel } from '../src/features/map/search-status.js';
import {
  formatBytes,
  offlineCatalogNotice,
  regionActions,
  regionFailureMessage,
  regionProgress,
  regionStatusText,
} from '../src/features/offline/offline-copy.js';
import { routeSourceForNativeTrip } from '../src/features/navigation/route-ui-state.js';

const region: NativeOfflineRegion = {
  attribution: [],
  bounds: [-114.9, 50.4, -113.1, 51.6],
  downloadBytes: 345_958_168,
  id: 'calgary',
  name: 'Calgary, Airdrie, Cochrane & Okotoks',
  state: 'not-downloaded',
  updateAvailable: false,
};

const state: NativeOfflineState = {
  catalog: 'not-published',
  networkAvailable: true,
  preferOffline: false,
  regions: [],
  stale: false,
  storageBytes: 0,
};

describe('offline maps copy', () => {
  it('formats sizes in decimal units like iOS storage', () => {
    expect(formatBytes(345_958_168)).toBe('346 MB');
    expect(formatBytes(1_167_831_577)).toBe('1.2 GB');
    expect(formatBytes(512)).toBe('512 bytes');
  });

  it('says plainly when nothing is published, without promising a download', () => {
    expect(offlineCatalogNotice(state)?.title).toBe('Offline maps are not available yet');
    const installed = {
      ...state,
      regions: [{ ...region, installedVersion: 'v', state: 'installed' as const }],
    };
    expect(offlineCatalogNotice(installed)?.message).toContain('keep working');
    expect(offlineCatalogNotice({ ...state, catalog: 'unsupported' })?.title).toBe(
      'Update NavOSS to download offline maps',
    );
    expect(offlineCatalogNotice({ ...state, catalog: 'available' })).toBeUndefined();
    // With the service down the saved list stays usable: installed regions can still be deleted,
    // and the copy says why nothing new can be downloaded.
    const stale = { ...installed, catalog: 'available' as const, stale: true };
    expect(offlineCatalogNotice(stale)?.message).toContain('need a connection');
    expect(regionActions({ ...region, installedVersion: 'v', state: 'installed' }, false)).toEqual([
      'delete',
    ]);
  });

  it('describes every region state and offers only valid actions', () => {
    expect(regionStatusText(region)).toBe('346 MB download');
    expect(regionActions(region, true)).toEqual(['download']);
    expect(regionActions(region, false)).toEqual([]);

    const downloading = {
      ...region,
      receivedBytes: 100_000_000,
      state: 'downloading' as const,
      totalBytes: 400_000_000,
    };
    expect(regionStatusText(downloading)).toBe('Downloading · 100 MB of 400 MB');
    expect(regionProgress(downloading)).toBe(0.25);
    expect(regionActions(downloading, true)).toEqual(['pause', 'cancel']);
    expect(regionActions({ ...downloading, state: 'paused' }, true)).toEqual(['resume', 'cancel']);
    expect(regionActions({ ...region, state: 'verifying' }, true)).toEqual([]);

    const installed = {
      ...region,
      installedBytes: 389_361_801,
      installedDataDate: '2026-11-11',
      installedVersion: 'v1',
      state: 'installed' as const,
      updateAvailable: true,
    };
    expect(regionStatusText(installed)).toBe(
      'On this device · 389 MB · Map data 2026-11-11 · Update available',
    );
    expect(regionActions(installed, true)).toEqual(['update', 'delete']);
    expect(regionActions({ ...installed, updateAvailable: false }, true)).toEqual(['delete']);
  });

  it('explains failures with the numbers the driver needs', () => {
    expect(
      regionFailureMessage({
        ...region,
        failure: { availableBytes: 120_000_000, reason: 'storage', requiredBytes: 512_000_000 },
        state: 'failed',
      }),
    ).toBe('Not enough free space. This needs 512 MB; 120 MB is free.');
    expect(
      regionFailureMessage({ ...region, failure: { reason: 'integrity' }, state: 'failed' }),
    ).toContain('checksum');
  });

  it('labels offline search results and offline routes wherever their source is shown', () => {
    expect(
      searchSourceLabel({
        datasetVersion: '2026-11-11-v1-798f5c442644',
        freshness: 'static',
        id: 'offline-osm',
        updatedAt: '2026-11-11T21:22:47Z',
      }),
    ).toBe('Offline results · OpenStreetMap data from 2026-11-11');
    expect(routeSourceForNativeTrip('offline-valhalla')).toEqual({
      attribution: 'Offline route · No traffic or closures',
      id: 'offline-valhalla',
      mode: 'offline',
      traffic: 'unavailable',
    });
  });
});
