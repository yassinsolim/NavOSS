import type { RoadEvent, RouteAlternativeV2, SearchResult } from '@navoss/contracts';
import { describe, expect, it } from 'vitest';

import {
  cameraDetailMessage,
  congestionFeatures,
  droppedPinResult,
  EMPTY_POINT_COLLECTION,
  itemsNearRoute,
  mapAttributionLabel,
  renderedFeatureId,
  roadEventFeatures,
  roadEventMessage,
  roadEventRegionForMapRegion,
  roadEventStatusLabel,
  routeBounds,
  routeFeatures,
  safetyCameraFeatures,
  searchResultFeatures,
  selectedPlaceFeature,
} from '../src/features/map/map-features.js';

const tower: SearchResult = {
  category: 'landmark',
  center: { latitude: 51.0443, longitude: -114.0631 },
  confidence: 1,
  id: 'tower',
  label: 'Calgary Tower, Calgary',
  name: 'Calgary Tower',
};
const library: SearchResult = { ...tower, id: 'library', name: 'Central Library' };

const incident: RoadEvent = {
  confidence: 'unverified',
  coordinate: { latitude: 51.05, longitude: -114.07 },
  description: 'Two vehicle incident.',
  id: 'incident-1',
  sourceId: 'calgary-current-incidents',
  startsAtLocal: '2026-11-12T08:30:00',
  timeZone: 'America/Edmonton',
  title: 'Macleod Trail at 9 Avenue SE',
  type: 'incident',
};

describe('road event regions', () => {
  it('draws road events only for the exact regions that publish them', () => {
    expect(roadEventRegionForMapRegion('calgary-ab')).toBe('calgary');
    expect(roadEventRegionForMapRegion('kelowna-bc')).toBe('kelowna-bc');
    expect(roadEventRegionForMapRegion('ontario')).toBe('ontario');
    // An unknown or unlocated position must never fall back to Calgary's overlays.
    expect(roadEventRegionForMapRegion('other')).toBeUndefined();
    expect(roadEventRegionForMapRegion(undefined)).toBeUndefined();
  });
});

describe('map feature builders', () => {
  it('reuses one empty collection when there is nothing to draw', () => {
    expect(selectedPlaceFeature(undefined)).toBe(EMPTY_POINT_COLLECTION);
    expect(searchResultFeatures([])).toBe(EMPTY_POINT_COLLECTION);
  });

  it('draws search results as longitude-latitude points that carry what a tap needs', () => {
    const collection = searchResultFeatures([tower, library]);
    expect(collection.features.map((feature) => feature.properties)).toEqual([
      { id: 'tower', name: 'Calgary Tower', rank: 0 },
      { id: 'library', name: 'Central Library', rank: 1 },
    ]);
    expect(collection.features[0]?.geometry.coordinates).toEqual([-114.0631, 51.0443]);
  });

  it('splits road events by type so each gets its own symbol', () => {
    const construction: RoadEvent = {
      ...incident,
      confidence: 'official',
      id: 'construction-1',
      sourceId: 'calgary-construction-detours',
      type: 'construction',
    };
    const events = [incident, construction];
    expect(roadEventFeatures(events, 'incident').features).toHaveLength(1);
    expect(roadEventFeatures(events, 'construction').features[0]?.properties).toEqual({
      id: 'construction-1',
    });
    expect(roadEventFeatures(events, 'closure').features).toEqual([]);
  });

  it('carries enforcement metadata on camera features and omits a direction it does not have', () => {
    const [withDirection, withoutDirection] = safetyCameraFeatures([
      {
        coordinate: { latitude: 51, longitude: -114 },
        direction: 'northbound',
        enforcement: ['red-light', 'speed-on-green'],
        id: 'camera-1',
        location: 'Macleod Trail at 9 Avenue',
      },
      {
        coordinate: { latitude: 51.1, longitude: -114.1 },
        enforcement: ['red-light'],
        id: 'camera-2',
        location: '16 Avenue at Centre Street',
      },
    ]).features;
    expect(withDirection?.properties).toEqual({
      direction: 'northbound',
      enforcement: 'red-light,speed-on-green',
      id: 'camera-1',
      location: 'Macleod Trail at 9 Avenue',
    });
    expect(withoutDirection?.properties).not.toHaveProperty('direction');
  });

  it('finds the first rendered feature that has an id', () => {
    expect(
      renderedFeatureId([
        { properties: null },
        { properties: { id: 7 } },
        { properties: { id: 'a' } },
      ]),
    ).toBe('a');
    expect(renderedFeatureId([])).toBeUndefined();
  });

  it('names a dropped pin by its rounded coordinate', () => {
    const pin = droppedPinResult({ latitude: 51.044712, longitude: -114.071934 });
    expect(pin.name).toBe('Dropped pin');
    expect(pin.label).toBe('51.04471, -114.07193');
    expect(pin.id).toBe('dropped-pin:51.04471:-114.07193');
    expect(pin.center).toEqual({ latitude: 51.044712, longitude: -114.071934 });
  });

  it('bounds a route by its whole geometry', () => {
    const route = {
      geometry: [
        [-114.08, 51.04],
        [-114.2, 51.09],
        [-114.01, 51.13],
      ],
      id: 'route-1',
    } as RouteAlternativeV2;
    expect(routeBounds(route)).toEqual([-114.2, 51.04, -114.01, 51.13]);
    expect(routeFeatures([route]).features[0]?.properties).toEqual({ id: 'route-1' });
  });
});

describe('overlay detail copy', () => {
  it('describes enforced direction as traffic flow, never as where the camera points', () => {
    const message = cameraDetailMessage(['red-light', 'speed-on-green'], 'northbound');
    expect(message).toContain('red light and speed on green enforcement camera.');
    expect(message).toContain('northbound traffic');
    expect(message).toContain("not the camera's optical facing");
    expect(cameraDetailMessage([], undefined)).toBe(
      'Unspecified enforcement camera.\nEnforced direction: unspecified by this source.',
    );
  });

  it('labels Calgary incidents as unverified and official sources as official', () => {
    expect(roadEventMessage(incident)).toContain('Unverified current incident information');
    expect(roadEventMessage(incident)).toContain('Starts: 2026-11-12 08:30:00');
    expect(
      roadEventMessage({
        ...incident,
        confidence: 'official',
        sourceId: 'calgary-construction-detours',
        type: 'construction',
      }),
    ).toContain('Official City of Calgary construction information');
  });

  it('states source, staleness and refresh problems for the road-event overlay', () => {
    const fresh = { hasSnapshot: true, refreshDelayed: false, stale: false } as const;
    expect(roadEventStatusLabel({ ...fresh, region: 'calgary' })).toBe(
      'Road events · City of Calgary · Incidents unverified',
    );
    expect(roadEventStatusLabel({ ...fresh, region: 'ontario', stale: true })).toBe(
      'Road events · Ontario 511 · Official · Stale snapshot',
    );
    expect(roadEventStatusLabel({ ...fresh, refreshDelayed: true, region: 'kelowna-bc' })).toBe(
      'Road events · DriveBC · Official · Refresh delayed',
    );
    expect(
      roadEventStatusLabel({
        hasSnapshot: false,
        refreshDelayed: true,
        region: 'calgary',
        stale: false,
      }),
    ).toBe('Road events unavailable');
    // Nothing has loaded and nothing has failed: no claim either way.
    expect(
      roadEventStatusLabel({
        hasSnapshot: false,
        refreshDelayed: false,
        region: undefined,
        stale: false,
      }),
    ).toBeUndefined();
  });

  it('credits only the data sources that are on the map', () => {
    expect(
      mapAttributionLabel({
        hasTorontoCameras: false,
        mapRegion: 'other',
        roadEventRegion: undefined,
      }),
    ).toBe('© OpenMapTiles · © OpenStreetMap');
    expect(
      mapAttributionLabel({
        hasTorontoCameras: false,
        mapRegion: 'calgary-ab',
        roadEventRegion: 'calgary',
      }),
    ).toBe('© OpenMapTiles · © OpenStreetMap · © City of Calgary');
    expect(
      mapAttributionLabel({
        hasTorontoCameras: true,
        mapRegion: 'ontario',
        roadEventRegion: 'ontario',
      }),
    ).toBe('© OpenMapTiles · © OpenStreetMap · © City of Toronto · Ontario 511');
    expect(
      mapAttributionLabel({
        hasTorontoCameras: false,
        mapRegion: 'kelowna-bc',
        roadEventRegion: 'kelowna-bc',
      }),
    ).toBe('© OpenMapTiles · © OpenStreetMap · DriveBC · RCMP');
  });
});

describe('items near a route', () => {
  // A route running north along longitude -114.08 for about 2.2 km.
  const route = {
    geometry: [
      [-114.08, 51.04],
      [-114.08, 51.05],
      [-114.08, 51.06],
    ] as [number, number][],
  };
  const at = (id: string, latitude: number, longitude: number) => ({
    coordinate: { latitude, longitude },
    id,
  });

  it('keeps cameras the route passes and drops the rest of the city', () => {
    const cameras = [
      at('on-route', 51.045, -114.0801),
      at('one-block-over', 51.045, -114.083),
      at('past-the-end', 51.07, -114.08),
      at('at-a-vertex', 51.05, -114.08),
    ];
    expect(itemsNearRoute(cameras, route, 60).map((camera) => camera.id)).toEqual([
      'on-route',
      'at-a-vertex',
    ]);
  });

  it('measures to the line between vertices, not only to the vertices', () => {
    const midSegment = at('mid', 51.055, -114.0804);
    expect(itemsNearRoute([midSegment], route, 60)).toEqual([midSegment]);
    expect(itemsNearRoute([midSegment], route, 10)).toEqual([]);
  });

  it('returns nothing for a route without geometry', () => {
    expect(itemsNearRoute([at('a', 51.04, -114.08)], { geometry: [] }, 60)).toEqual([]);
  });
});

describe('congestion features', () => {
  const geometry: RouteAlternativeV2['geometry'] = [
    [-114.1, 51.0],
    [-114.09, 51.0],
    [-114.08, 51.0],
    [-114.07, 51.0],
    [-114.06, 51.0],
  ];

  it('draws slow, heavy and stopped runs and leaves free or unknown road alone', () => {
    const features = congestionFeatures({
      congestion: ['free', 'slow', 'slow', 'stopped'],
      geometry,
    });
    expect(features?.features.map((feature) => feature.properties)).toEqual([
      { level: 'slow' },
      { level: 'stopped' },
    ]);
    expect(features?.features[0]?.geometry.coordinates).toEqual(geometry.slice(1, 4));
  });

  it('draws nothing without aligned congestion', () => {
    expect(congestionFeatures({ geometry })).toBeUndefined();
    expect(congestionFeatures({ congestion: ['slow'], geometry })).toBeUndefined();
  });

  it('drops the part already driven', () => {
    const features = congestionFeatures(
      { congestion: ['heavy', 'heavy', 'heavy', 'heavy'], geometry },
      0.5,
    );
    const coordinates = features?.features[0]?.geometry.coordinates;
    expect(coordinates?.[0]?.[0]).toBeCloseTo(-114.08, 5);
    expect(coordinates?.at(-1)).toEqual([-114.06, 51.0]);
  });
});
