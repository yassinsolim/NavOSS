import type { Feature, LineString, Point } from 'geojson';
import { describe, expect, it } from 'vitest';

import {
  enrichMapPlace,
  mapPlaceFromRenderedFeatures,
  openStreetMapPlaceUrl,
  placeOpenStatus,
  placeOpenStatusLabel,
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

describe('place opening-hours status', () => {
  const calgaryCenter = { latitude: 51.04427, longitude: -114.06309 };
  const kelownaCenter = { latitude: 49.888, longitude: -119.496 };
  const torontoCenter = { latitude: 43.6532, longitude: -79.3832 };
  const place = (openingHours: string, center = calgaryCenter) => ({
    category: 'poi' as const,
    center,
    confidence: 1,
    details: { openingHours },
    id: 'place',
    label: 'Place',
    name: 'Place',
  });

  it('reports open well inside stated hours', () => {
    // Wednesday 12:30 America/Edmonton
    expect(placeOpenStatus(place('Mo-Su 10:00-21:00'), new Date('2026-09-23T18:30:00Z'))).toBe(
      'open',
    );
  });

  it('reports closing soon within the last hour before close', () => {
    // Tuesday 20:30 America/Edmonton, closes 21:00
    expect(placeOpenStatus(place('Mo-Su 10:00-21:00'), new Date('2026-09-23T02:30:00Z'))).toBe(
      'closing-soon',
    );
  });

  it('reports closed outside stated hours on a covered day', () => {
    // Wednesday 07:00 America/Edmonton, opens 08:00
    expect(placeOpenStatus(place('Mo-Fr 08:00-09:00'), new Date('2026-09-23T13:00:00Z'))).toBe(
      'closed',
    );
  });

  it('treats the opening minute as open and the closing minute as closed', () => {
    // Wednesday 10:00 America/Edmonton exactly
    expect(placeOpenStatus(place('Mo-Su 10:00-21:00'), new Date('2026-09-23T16:00:00Z'))).toBe(
      'open',
    );
    // Wednesday 21:00 America/Edmonton exactly (end is exclusive)
    expect(placeOpenStatus(place('Mo-Su 10:00-21:00'), new Date('2026-09-24T03:00:00Z'))).toBe(
      'closed',
    );
  });

  it('closes during the gap between split shifts and reopens after it', () => {
    const hours = 'Mo-Fr 08:00-12:00,13:00-17:00';
    // Wednesday 12:30 America/Edmonton (lunch gap)
    expect(placeOpenStatus(place(hours), new Date('2026-09-23T18:30:00Z'))).toBe('closed');
    // Wednesday 14:00 America/Edmonton (afternoon shift)
    expect(placeOpenStatus(place(hours), new Date('2026-09-23T20:00:00Z'))).toBe('open');
  });

  it('lets a later same-day rule override an earlier catch-all range', () => {
    // Friday 14:00 America/Edmonton: the Fr-specific 09:00-13:00 rule replaces Mo-Fr 09:00-17:00
    expect(
      placeOpenStatus(place('Mo-Fr 09:00-17:00; Fr 09:00-13:00'), new Date('2026-09-25T20:00:00Z')),
    ).toBe('closed');
  });

  it('lets an explicit day-off override a catch-all range', () => {
    // Sunday 12:00 America/Edmonton
    expect(
      placeOpenStatus(place('Mo-Su 09:00-17:00; Su off'), new Date('2026-09-20T18:00:00Z')),
    ).toBe('closed');
  });

  it('resolves overnight hours that cross midnight', () => {
    const hours = 'Mo-Su 18:00-02:00';
    // Wednesday 00:00 America/Edmonton: clearly open, well before the 02:00 close
    expect(placeOpenStatus(place(hours), new Date('2026-09-23T06:00:00Z'))).toBe('open');
    // Wednesday 01:00 America/Edmonton: exactly one hour before the 02:00 close
    expect(placeOpenStatus(place(hours), new Date('2026-09-23T07:00:00Z'))).toBe('closing-soon');
    // Wednesday 02:00 America/Edmonton exactly: closed (end is exclusive)
    expect(placeOpenStatus(place(hours), new Date('2026-09-23T08:00:00Z'))).toBe('closed');
  });

  it('carries an overnight rule across the Sunday-to-Monday week seam', () => {
    // Monday 01:00 America/Edmonton, reached only via Sunday's 18:00-02:00 overnight extension
    expect(placeOpenStatus(place('Mo-Su 18:00-02:00'), new Date('2026-09-21T07:00:00Z'))).toBe(
      'closing-soon',
    );
  });

  it('matches the merged overnight coverage at the week seam instead of an incomplete shifted mirror', () => {
    const hours = 'Mo-Su 00:00-01:00,23:00-02:00';
    // Monday 00:30 America/Edmonton: still 90 minutes from the 02:00 close carried over from
    // Sunday's 23:00-02:00 span, which subsumes Monday's own 00:00-01:00 range.
    expect(placeOpenStatus(place(hours), new Date('2026-09-21T06:30:00Z'))).toBe('open');
    // Monday 01:00 America/Edmonton: exactly 60 minutes from that same 02:00 close.
    expect(placeOpenStatus(place(hours), new Date('2026-09-21T07:00:00Z'))).toBe('closing-soon');
  });

  it('clips an overnight spillover when an explicit day-off overrides the following day', () => {
    // Tuesday 01:00 America/Edmonton: "Tu off" fully overrides Tuesday, so Monday's 18:00-02:00
    // overnight extension no longer bleeds into Tuesday morning.
    expect(
      placeOpenStatus(place('Mo-Su 18:00-02:00; Tu off'), new Date('2026-09-22T07:00:00Z')),
    ).toBe('closed');
  });

  it('clips an overnight spillover when a later rule replaces the following day with different hours', () => {
    const hours = 'Mo-Su 18:00-02:00; Tu 06:00-10:00';
    // Tuesday 01:00 America/Edmonton: the Tu-specific 06:00-10:00 rule replaces Tuesday entirely,
    // so Monday's overnight extension no longer reaches into it.
    expect(placeOpenStatus(place(hours), new Date('2026-09-22T07:00:00Z'))).toBe('closed');
    // Tuesday 07:00 America/Edmonton: within the replacement 06:00-10:00 rule itself.
    expect(placeOpenStatus(place(hours), new Date('2026-09-22T13:00:00Z'))).toBe('open');
  });

  it('excludes Sunday morning from a Saturday overnight rule under normal OSM semicolon precedence', () => {
    const hours = 'Sa 16:00-03:00; Su 16:00-23:00';
    // Sunday 01:00 America/Edmonton: the Su-specific 16:00-23:00 rule replaces Sunday entirely, so
    // Saturday's 16:00-03:00 overnight extension no longer reaches into Sunday morning.
    expect(placeOpenStatus(place(hours), new Date('2026-09-20T07:00:00Z'))).toBe('closed');
    // Saturday 17:00 America/Edmonton: Saturday's own rule is unaffected and still open.
    expect(placeOpenStatus(place(hours), new Date('2026-09-19T23:00:00Z'))).toBe('open');
    // Sunday 16:00 America/Edmonton: Sunday's own replacement rule opens as stated.
    expect(placeOpenStatus(place(hours), new Date('2026-09-20T22:00:00Z'))).toBe('open');
  });

  it('preserves overnight continuation between days left untouched by a later override', () => {
    // Thursday 01:00 America/Edmonton, reached via Wednesday's 18:00-02:00 overnight extension:
    // "Tu off" only overrides Tuesday, so the same Mo-Su rule still fuses Wednesday into Thursday.
    expect(
      placeOpenStatus(place('Mo-Su 18:00-02:00; Tu off'), new Date('2026-09-24T07:00:00Z')),
    ).toBe('closing-soon');
  });

  it('never reports closing soon for a genuine 24/7 schedule at the week seam', () => {
    // Sunday 23:50 and Monday 00:10 America/Edmonton, either side of the weekly wraparound
    expect(placeOpenStatus(place('24/7'), new Date('2026-09-21T05:50:00Z'))).toBe('open');
    expect(placeOpenStatus(place('24/7'), new Date('2026-09-21T06:10:00Z'))).toBe('open');
  });

  it('keeps holiday, seasonal, and freeform-comment hours unknown rather than guessing', () => {
    const now = new Date('2026-09-23T18:30:00Z');
    expect(placeOpenStatus(place('Mo-Fr 09:00-17:00; PH off'), now)).toBeUndefined();
    expect(placeOpenStatus(place('Mo-Fr 09:00-17:00 "call ahead"'), now)).toBeUndefined();
    expect(placeOpenStatus(place('Mo-Fr 09:00-17:00; Dec 24-25 off'), now)).toBeUndefined();
  });

  it('rejects an invalid or reversed time field instead of guessing', () => {
    expect(
      placeOpenStatus(place('Mo-Fr 25:00-09:00'), new Date('2026-09-23T18:30:00Z')),
    ).toBeUndefined();
  });

  it('rejects unknown weekday names, including inherited object property names', () => {
    const now = new Date('2026-09-23T18:30:00Z');
    expect(placeOpenStatus(place('Monday 09:00-17:00'), now)).toBeUndefined();
    expect(placeOpenStatus(place('constructor 09:00-17:00'), now)).toBeUndefined();
  });

  it('keeps hours unknown outside the app-supported time zone regions', () => {
    expect(
      placeOpenStatus(place('Mo-Su 09:00-17:00', torontoCenter), new Date('2026-09-23T18:30:00Z')),
    ).toBeUndefined();
  });

  it('resolves a Kelowna coordinate to the Pacific time zone', () => {
    // Thursday 12:05 America/Vancouver
    expect(
      placeOpenStatus(place('Mo-Su 10:00-21:00', kelownaCenter), new Date('2026-01-15T20:05:00Z')),
    ).toBe('open');
  });

  it('omits the closing-soon claim across a real daylight-saving transition', () => {
    // Sunday 01:30 America/Edmonton on 2025-11-02, the actual fall-back date in this runtime's
    // time zone data: the next 60 real minutes cross the transition, so the wall-clock distance
    // to the 02:00 close is no longer real elapsed time.
    expect(placeOpenStatus(place('Su 00:00-02:00'), new Date('2025-11-02T07:30:00Z'))).toBe('open');
    // The same wall-clock scenario one week earlier, with no transition nearby, still warns.
    expect(placeOpenStatus(place('Su 00:00-02:00'), new Date('2025-10-26T07:30:00Z'))).toBe(
      'closing-soon',
    );
  });

  it('labels each status for display', () => {
    expect(placeOpenStatusLabel('open')).toBe('Open now');
    expect(placeOpenStatusLabel('closing-soon')).toBe('Closing soon');
    expect(placeOpenStatusLabel('closed')).toBe('Closed');
  });
});
