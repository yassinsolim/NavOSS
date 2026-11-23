/**
 * The map's handheld controls on Android (`modules/navoss-input`): L1 zooms out, R1 zooms in,
 * pressing the right stick recenters and the right stick pans. The D-pad and left stick stay
 * with focus navigation between controls.
 */

/** A full stick deflection pans this many points (dp) a second, about a third of the map. */
export const STICK_PAN_POINTS_PER_SECOND = 600;

const MIN_ZOOM = 2;
const MAX_ZOOM = 20;
/** MapLibre's world is 512 points wide at zoom 0. */
const WORLD_POINTS = 512;
const EARTH_CIRCUMFERENCE_METERS = 40_075_016.686;
const METERS_PER_DEGREE_LATITUDE = 111_320;
const MAX_LATITUDE = 85;

const radians = (degrees: number) => (degrees * Math.PI) / 180;

/**
 * The map centre after the right stick has been held at `stick` for `seconds`. The stick is in
 * screen terms (x right, y down, each -1..1), so on a rotated map it still moves what the driver
 * sees; the distance is a fixed share of the screen at any zoom.
 */
export function stickPanCenter(
  view: { bearing: number; center: readonly [number, number]; zoom: number },
  stick: { x: number; y: number },
  seconds: number,
): [number, number] {
  const [longitude, latitude] = view.center;
  if (stick.x === 0 && stick.y === 0) return [longitude, latitude];
  const right = stick.x * STICK_PAN_POINTS_PER_SECOND * seconds;
  const down = stick.y * STICK_PAN_POINTS_PER_SECOND * seconds;
  const bearing = radians(view.bearing);
  const cosLatitude = Math.cos(radians(latitude));
  const metersPerPoint =
    (EARTH_CIRCUMFERENCE_METERS * cosLatitude) / (WORLD_POINTS * 2 ** view.zoom);
  const east = (right * Math.cos(bearing) - down * Math.sin(bearing)) * metersPerPoint;
  const north = (-right * Math.sin(bearing) - down * Math.cos(bearing)) * metersPerPoint;
  const nextLatitude = latitude + north / METERS_PER_DEGREE_LATITUDE;
  const nextLongitude = longitude + east / (METERS_PER_DEGREE_LATITUDE * cosLatitude);
  return [
    ((((nextLongitude + 180) % 360) + 360) % 360) - 180,
    Math.max(-MAX_LATITUDE, Math.min(MAX_LATITUDE, nextLatitude)),
  ];
}

/** The zoom one shoulder-button press leads to, inside the map's limits. */
export function keyZoom(zoom: number, command: 'zoom-in' | 'zoom-out'): number {
  const next = command === 'zoom-in' ? zoom + 1 : zoom - 1;
  return Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, next));
}
