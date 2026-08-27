import { describe, expect, it } from 'vitest';

import {
  HEADING_CONE_RADIUS_METERS,
  HEADING_CONE_SPREAD_DEGREES,
  HEADING_CONE_TARGET_POINTS,
  headingConeFeature,
  headingConePolygon,
  headingConeRadiusMeters,
} from '../src/features/map/heading-cone.js';

const CALGARY = { latitude: 51.0447, longitude: -114.0719 };
const METERS_PER_DEGREE_LATITUDE = 110_540;
const METERS_PER_DEGREE_LONGITUDE_AT_EQUATOR = 111_320;

function bearingFromApexDegrees(point: { latitude: number; longitude: number }): number {
  const north = (point.latitude - CALGARY.latitude) * METERS_PER_DEGREE_LATITUDE;
  const east =
    (point.longitude - CALGARY.longitude) *
    METERS_PER_DEGREE_LONGITUDE_AT_EQUATOR *
    Math.cos((CALGARY.latitude * Math.PI) / 180);
  return (((Math.atan2(east, north) * 180) / Math.PI) + 360) % 360;
}

function distanceFromApexMeters(point: { latitude: number; longitude: number }): number {
  const north = (point.latitude - CALGARY.latitude) * METERS_PER_DEGREE_LATITUDE;
  const east =
    (point.longitude - CALGARY.longitude) *
    METERS_PER_DEGREE_LONGITUDE_AT_EQUATOR *
    Math.cos((CALGARY.latitude * Math.PI) / 180);
  return Math.hypot(north, east);
}

describe('headingConePolygon', () => {
  it('closes the ring at the apex so the wedge fills', () => {
    const ring = headingConePolygon(CALGARY, 90);

    expect(ring.at(0)).toEqual(CALGARY);
    expect(ring.at(-1)).toEqual(CALGARY);
  });

  it('places every arc point at the requested radius', () => {
    const arc = headingConePolygon(CALGARY, 90).slice(1, -1);

    for (const point of arc) {
      expect(distanceFromApexMeters(point)).toBeCloseTo(HEADING_CONE_RADIUS_METERS, 1);
    }
  });

  it('centres the arc on the heading rather than on north', () => {
    const arc = headingConePolygon(CALGARY, 90).slice(1, -1);
    const bearings = arc.map(bearingFromApexDegrees);

    expect(Math.min(...bearings)).toBeCloseTo(90 - HEADING_CONE_SPREAD_DEGREES / 2, 1);
    expect(Math.max(...bearings)).toBeCloseTo(90 + HEADING_CONE_SPREAD_DEGREES / 2, 1);
  });

  it('rotates with the heading', () => {
    const facingSouth = headingConePolygon(CALGARY, 180).slice(1, -1);
    const bearings = facingSouth.map(bearingFromApexDegrees);

    expect(Math.min(...bearings)).toBeCloseTo(180 - HEADING_CONE_SPREAD_DEGREES / 2, 1);
    expect(Math.max(...bearings)).toBeCloseTo(180 + HEADING_CONE_SPREAD_DEGREES / 2, 1);
  });

  it('samples the arc finely enough not to look faceted', () => {
    const bearings = headingConePolygon(CALGARY, 0).slice(1, -1).map(bearingFromApexDegrees);
    const unwrapped = bearings.map((bearing) => (bearing > 180 ? bearing - 360 : bearing)).sort((a, b) => a - b);

    for (let index = 1; index < unwrapped.length; index += 1) {
      expect(unwrapped[index]! - unwrapped[index - 1]!).toBeLessThanOrEqual(5.001);
    }
  });

  it('does not skew east-west at high latitude', () => {
    const arctic = { latitude: 78, longitude: 15 };
    const east = headingConePolygon(arctic, 90, 30, 0.0001).at(1)!;
    const north = headingConePolygon(arctic, 0, 30, 0.0001).at(1)!;

    const eastMeters = Math.hypot(
      (east.latitude - arctic.latitude) * METERS_PER_DEGREE_LATITUDE,
      (east.longitude - arctic.longitude) *
        METERS_PER_DEGREE_LONGITUDE_AT_EQUATOR *
        Math.cos((arctic.latitude * Math.PI) / 180),
    );
    const northMeters = (north.latitude - arctic.latitude) * METERS_PER_DEGREE_LATITUDE;

    expect(eastMeters).toBeCloseTo(northMeters, 1);
  });

  it('refuses to draw a degenerate wedge', () => {
    expect(headingConePolygon(CALGARY, Number.NaN)).toEqual([]);
    expect(headingConePolygon(CALGARY, 90, 0)).toEqual([]);
    expect(headingConePolygon(CALGARY, 90, 30, 0)).toEqual([]);
  });
});

describe('headingConeFeature', () => {
  it('yields nothing without a position or a heading', () => {
    expect(headingConeFeature(undefined, 90)).toBeUndefined();
    expect(headingConeFeature(CALGARY, undefined)).toBeUndefined();
  });

  it('emits GeoJSON longitude-first', () => {
    const feature = headingConeFeature(CALGARY, 90);

    expect(feature?.geometry.coordinates[0]?.at(0)).toEqual([CALGARY.longitude, CALGARY.latitude]);
  });
});

describe('headingConeRadiusMeters', () => {
  it('holds a constant on-screen size as the map zooms', () => {
    const metersPerPointAt = (zoom: number) =>
      headingConeRadiusMeters(CALGARY.latitude, zoom) / HEADING_CONE_TARGET_POINTS;

    // One zoom level in is exactly half the ground resolution, so the cone must halve in metres
    // to occupy the same number of points.
    expect(metersPerPointAt(15) / metersPerPointAt(16)).toBeCloseTo(2, 5);
    // Zoom 12 would want a 1.1 km cone, which the guard clamps, so stay in the unclamped range.
    expect(metersPerPointAt(14) / metersPerPointAt(16)).toBeCloseTo(4, 5);
  });

  it('shrinks with latitude, matching Web Mercator ground resolution', () => {
    expect(headingConeRadiusMeters(60, 15)).toBeLessThan(headingConeRadiusMeters(0, 15));
  });

  it('is far larger than the fixed radius at browsing zoom, where 30 m was invisible', () => {
    // The first cut used a fixed 30 m, which measured about 18 points at browsing zoom.
    expect(headingConeRadiusMeters(CALGARY.latitude, 14)).toBeGreaterThan(4 * 30);
  });

  it('occupies the same screen size at browsing and navigation zoom', () => {
    const browsing = headingConeRadiusMeters(CALGARY.latitude, 14) / 2 ** -14;
    const navigating = headingConeRadiusMeters(CALGARY.latitude, 16) / 2 ** -16;

    expect(browsing).toBeCloseTo(navigating, 5);
  });

  it('falls back to the fixed radius before the map reports a zoom', () => {
    expect(headingConeRadiusMeters(CALGARY.latitude, undefined)).toBe(HEADING_CONE_RADIUS_METERS);
    expect(headingConeRadiusMeters(CALGARY.latitude, Number.NaN)).toBe(HEADING_CONE_RADIUS_METERS);
  });

  it('clamps absurd zooms rather than emitting a degenerate or planetary cone', () => {
    expect(headingConeRadiusMeters(CALGARY.latitude, 30)).toBeGreaterThan(0);
    expect(headingConeRadiusMeters(CALGARY.latitude, -5)).toBe(600);
    expect(headingConeRadiusMeters(CALGARY.latitude, 30)).toBe(8);
  });
});
