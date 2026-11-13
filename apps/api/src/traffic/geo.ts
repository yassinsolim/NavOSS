export type Position = [longitude: number, latitude: number];

const EARTH_RADIUS_METERS = 6_371_008.8;

export function haversineMeters(from: Position, to: Position): number {
  const fromLatitude = (from[1] * Math.PI) / 180;
  const toLatitude = (to[1] * Math.PI) / 180;
  const deltaLatitude = toLatitude - fromLatitude;
  const deltaLongitude = ((to[0] - from[0]) * Math.PI) / 180;
  const a =
    Math.sin(deltaLatitude / 2) ** 2 +
    Math.cos(fromLatitude) * Math.cos(toLatitude) * Math.sin(deltaLongitude / 2) ** 2;
  return 2 * EARTH_RADIUS_METERS * Math.asin(Math.min(1, Math.sqrt(a)));
}

/** Path distance from the first position to each position, in metres. */
export function cumulativeMeters(positions: readonly Position[]): number[] {
  const distances: number[] = [];
  let previous: Position | undefined;
  let total = 0;
  for (const position of positions) {
    if (previous !== undefined) total += haversineMeters(previous, position);
    distances.push(total);
    previous = position;
  }
  return distances;
}

/** Decodes Valhalla's six-decimal encoded polyline into `[longitude, latitude]` positions. */
export function decodePolyline6(encoded: string): Position[] {
  const positions: Position[] = [];
  let index = 0;
  let latitude = 0;
  let longitude = 0;
  const nextDelta = (): number => {
    let result = 0;
    let shift = 0;
    let byte: number;
    do {
      if (index >= encoded.length) throw new RangeError('Truncated polyline.');
      byte = encoded.charCodeAt(index) - 63;
      index += 1;
      // Multiplication instead of a bit shift keeps large coordinates exact past 32 bits.
      result += (byte & 0x1f) * 2 ** shift;
      shift += 5;
    } while (byte >= 0x20);
    return result % 2 === 1 ? -(result + 1) / 2 : result / 2;
  };
  while (index < encoded.length) {
    latitude += nextDelta();
    longitude += nextDelta();
    positions.push([longitude / 1e6, latitude / 1e6]);
  }
  return positions;
}
