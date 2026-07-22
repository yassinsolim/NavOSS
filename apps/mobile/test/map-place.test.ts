import type { Feature, LineString, Point } from 'geojson';
import { describe, expect, it } from 'vitest';

import {
  enrichMapPlace,
  mapPlaceFromRenderedFeatures,
  openStreetMapPlaceUrl,
  placePhoneUrl,
  placeReviewsUrl,
  placeShareMessage,
  placeWebsiteLabel,
  placeWebsiteUrl,
} from '../src/features/map/map-place.js';

describe('rendered map places', () => {
  it('normalizes a named gas station into a tappable place', () => {
    const feature: Feature<Point> = {
      geometry: { coordinates: [-114.07, 51.05], type: 'Point' },
      properties: { name_en: 'Downtown Fuel', osm_id: 42, subclass: 'fuel' },
      type: 'Feature',
    };

    expect(mapPlaceFromRenderedFeatures([feature], { latitude: 51, longitude: -114 })).toEqual({
      category: 'poi',
      center: { latitude: 51.05, longitude: -114.07 },
      confidence: 1,
      id: 'map-poi:42',
      label: 'Gas station',
      name: 'Downtown Fuel',
    });
  });

  it('uses the press coordinate for a named non-point feature', () => {
    const feature: Feature<LineString> = {
      geometry: {
        coordinates: [
          [-114.08, 51.04],
          [-114.07, 51.05],
        ],
        type: 'LineString',
      },
      properties: { class: 'museum', name: 'Test Museum' },
      type: 'Feature',
    };

    expect(
      mapPlaceFromRenderedFeatures([feature], { latitude: 51.045, longitude: -114.075 })?.center,
    ).toEqual({ latitude: 51.045, longitude: -114.075 });
  });

  it('ignores rendered features without a place name', () => {
    const feature: Feature<Point> = {
      geometry: { coordinates: [-114.07, 51.05], type: 'Point' },
      properties: { class: 'cafe' },
      type: 'Feature',
    };

    expect(
      mapPlaceFromRenderedFeatures([feature], { latitude: 51.05, longitude: -114.07 }),
    ).toBeUndefined();
  });

  it('enriches a rendered place from the nearest matching branch', () => {
    const place = mapPlaceFromRenderedFeatures(
      [
        {
          geometry: { coordinates: [-114.071, 51.045], type: 'Point' },
          properties: { class: 'cafe', name: 'Coffee House' },
          type: 'Feature',
        },
      ],
      { latitude: 51.045, longitude: -114.071 },
    );

    expect(
      enrichMapPlace(place!, [
        {
          category: 'poi',
          center: { latitude: 51.08, longitude: -114.1 },
          confidence: 1,
          details: { address: 'Far away' },
          id: 'far',
          label: 'Far away',
          name: 'Coffee House',
        },
        {
          category: 'poi',
          center: { latitude: 51.0451, longitude: -114.0711 },
          confidence: 0.9,
          details: { address: '101 Test Avenue SW' },
          id: 'near',
          label: '101 Test Avenue SW',
          name: 'Coffee House',
        },
      ]),
    ).toMatchObject({
      center: { latitude: 51.045, longitude: -114.071 },
      details: { address: '101 Test Avenue SW' },
      id: place?.id,
      label: 'Cafe',
    });
  });

  it('removes a repeated place name from the detail address', () => {
    const place = {
      category: 'poi' as const,
      center: { latitude: 51.04331, longitude: -114.07057 },
      confidence: 1,
      id: 'map-poi:restaurant',
      label: 'Restaurant',
      name: 'Craft Beer Market',
    };

    expect(
      enrichMapPlace(place, [
        {
          ...place,
          center: { latitude: 51.0433, longitude: -114.0706 },
          details: {
            address: 'Craft Beer Market, 345 10 Avenue SW, Calgary, Alberta',
          },
          id: 'nominatim:node:1',
        },
      ]).details?.address,
    ).toBe('345 10 Avenue SW, Calgary, Alberta');
  });

  it('declines ambiguous same-name branches without an OSM identity match', () => {
    const place = {
      category: 'poi' as const,
      center: { latitude: 51.0447, longitude: -114.0719 },
      confidence: 1,
      id: 'map-poi:Coffee Shop:51.04470:-114.07190',
      label: 'Cafe',
      name: 'Coffee Shop',
    };
    const candidates = [0.0001, 0.0002].map((offset, index) => ({
      ...place,
      center: { latitude: place.center.latitude + offset, longitude: place.center.longitude },
      details: { address: `${String(index + 1)} Test Street` },
      id: `nominatim:node:${String(index + 1)}`,
    }));

    expect(enrichMapPlace(place, candidates)).toBe(place);
  });

  it('prefers a matching OSM identity over branch proximity', () => {
    const place = {
      category: 'poi' as const,
      center: { latitude: 51.0447, longitude: -114.0719 },
      confidence: 1,
      id: 'map-poi:42',
      label: 'Cafe',
      name: 'Coffee Shop',
    };

    expect(
      enrichMapPlace(place, [
        {
          ...place,
          center: { latitude: 51.045, longitude: -114.072 },
          details: { address: 'Correct branch' },
          id: 'nominatim:node:42',
        },
      ]).details?.address,
    ).toBe('Correct branch');
  });

  it('rejects an OSM identity collision outside the detail radius', () => {
    const place = {
      category: 'poi' as const,
      center: { latitude: 51.0447, longitude: -114.0719 },
      confidence: 1,
      id: 'map-poi:42',
      label: 'Cafe',
      name: 'Coffee Shop',
    };

    expect(
      enrichMapPlace(place, [
        {
          ...place,
          center: { latitude: 51.08, longitude: -114.1 },
          details: { address: 'Wrong distant object' },
          id: 'nominatim:way:42',
        },
      ]),
    ).toBe(place);
  });

  it('builds explicit open-map share and external review links', () => {
    const place = {
      category: 'poi' as const,
      center: { latitude: 51.04427, longitude: -114.06309 },
      confidence: 1,
      details: { address: '101 9 Avenue SW' },
      id: 'tower',
      label: 'Attraction',
      name: 'Calgary Tower',
    };

    expect(openStreetMapPlaceUrl(place)).toContain('openstreetmap.org');
    expect(placeReviewsUrl(place)).toContain('google.com/maps/search');
    expect(placeShareMessage(place)).toContain('101 9 Avenue SW');
  });

  it('allows only sanitized call and website actions', () => {
    expect(placePhoneUrl('+1 (403) 266-7171; +1 403 000-0000')).toBe('tel:+14032667171');
    expect(placeWebsiteUrl('www.calgarytower.com')).toBe('https://www.calgarytower.com/');
    expect(placeWebsiteUrl('http://calgarytower.com')).toBe('https://calgarytower.com/');
    expect(placeWebsiteLabel('https://www.calgarytower.com/visit')).toBe('calgarytower.com');
    expect(placeWebsiteUrl('javascript:alert(1)')).toBeUndefined();
    expect(placeWebsiteUrl('https://user:pass@example.com')).toBeUndefined();
    expect(placeWebsiteUrl('http://localhost')).toBeUndefined();
    expect(placeWebsiteUrl('http://192.168.1.10')).toBeUndefined();
    expect(placePhoneUrl('*123#')).toBeUndefined();
  });
});
