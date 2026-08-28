import type { Coordinate } from '@navoss/contracts';

/** Total spread of the facing cone, centred on the heading. */
export const HEADING_CONE_SPREAD_DEGREES = 60;
/** On-screen length of the cone, in points. Sized to read like the Google Maps indicator. */
export const HEADING_CONE_TARGET_POINTS = 46;
/** Fallback length when the map zoom is not yet known. */
export const HEADING_CONE_RADIUS_METERS = 30;
/** Web Mercator ground resolution at zoom 0 on the equator, in metres per pixel. */
const EQUATORIAL_METERS_PER_PIXEL = 156_543.033_92;
/** Keeps the cone sane if the map reports an absurd zoom. */
const MIN_CONE_RADIUS_METERS = 8;
const MAX_CONE_RADIUS_METERS = 600;
/** Arc sampling step. Fine enough that the curve does not read as faceted. */
const HEADING_CONE_ARC_STEP_DEGREES = 5;

const METERS_PER_DEGREE_LATITUDE = 110_540;
const METERS_PER_DEGREE_LONGITUDE_AT_EQUATOR = 111_320;
const DEGREES_TO_RADIANS = Math.PI / 180;

/**
 * Closed polygon ring for the Google-Maps-style facing cone: apex at the vehicle, then an arc
 * sampled across the spread, then back to the apex.
 *
 * Bearings are true-north-relative and increase clockwise, matching every other heading in this
 * codebase. Returns an empty array when the inputs cannot describe a wedge, so callers render
 * nothing rather than a degenerate shape.
 */
export function headingConePolygon(
  apex: Coordinate,
  headingDegrees: number,
  radiusMeters = HEADING_CONE_RADIUS_METERS,
  spreadDegrees = HEADING_CONE_SPREAD_DEGREES,
): Coordinate[] {
  if (!Number.isFinite(headingDegrees)) return [];
  if (!Number.isFinite(radiusMeters) || radiusMeters <= 0) return [];
  if (!Number.isFinite(spreadDegrees) || spreadDegrees <= 0) return [];
  if (!Number.isFinite(apex.latitude) || !Number.isFinite(apex.longitude)) return [];

  // Longitude degrees shorten with latitude; without this the cone skews east-west.
  const longitudeScale = Math.cos(apex.latitude * DEGREES_TO_RADIANS);
  if (longitudeScale <= 0) return [];

  const start = headingDegrees - spreadDegrees / 2;
  const steps = Math.max(1, Math.ceil(spreadDegrees / HEADING_CONE_ARC_STEP_DEGREES));

  const ring: Coordinate[] = [{ latitude: apex.latitude, longitude: apex.longitude }];
  for (let step = 0; step <= steps; step += 1) {
    const bearing = (start + (spreadDegrees * step) / steps) * DEGREES_TO_RADIANS;
    ring.push({
      latitude: apex.latitude + (radiusMeters * Math.cos(bearing)) / METERS_PER_DEGREE_LATITUDE,
      longitude:
        apex.longitude +
        (radiusMeters * Math.sin(bearing)) /
          (METERS_PER_DEGREE_LONGITUDE_AT_EQUATOR * longitudeScale),
    });
  }
  ring.push({ latitude: apex.latitude, longitude: apex.longitude });
  return ring;
}

/**
 * Cone length in metres that occupies a constant number of screen points at the given zoom.
 *
 * A fixed metre radius is unusable in practice: at city-browsing zoom a 30 m cone is under twenty
 * points and effectively invisible, while at navigation zoom it swamps the vehicle. Google keeps
 * its indicator a constant size on screen, so this converts through the standard Web Mercator
 * ground resolution, which shrinks with latitude and halves with every zoom level.
 */
export function headingConeRadiusMeters(latitude: number, zoom: number | undefined): number {
  if (zoom === undefined || !Number.isFinite(zoom) || !Number.isFinite(latitude)) {
    return HEADING_CONE_RADIUS_METERS;
  }
  const metersPerPixel =
    (EQUATORIAL_METERS_PER_PIXEL * Math.cos(latitude * DEGREES_TO_RADIANS)) / 2 ** zoom;
  const radius = HEADING_CONE_TARGET_POINTS * metersPerPixel;
  if (!Number.isFinite(radius)) return HEADING_CONE_RADIUS_METERS;
  return Math.min(MAX_CONE_RADIUS_METERS, Math.max(MIN_CONE_RADIUS_METERS, radius));
}

/** GeoJSON feature for the facing cone, or `undefined` when there is nothing to draw. */
export function headingConeFeature(
  apex: Coordinate | undefined,
  headingDegrees: number | undefined,
  zoom?: number,
): GeoJSON.Feature<GeoJSON.Polygon> | undefined {
  if (apex === undefined || headingDegrees === undefined) return undefined;
  const ring = headingConePolygon(
    apex,
    headingDegrees,
    headingConeRadiusMeters(apex.latitude, zoom),
  );
  if (ring.length === 0) return undefined;
  return {
    geometry: {
      coordinates: [ring.map(({ latitude, longitude }) => [longitude, latitude])],
      type: 'Polygon',
    },
    properties: {},
    type: 'Feature',
  };
}
