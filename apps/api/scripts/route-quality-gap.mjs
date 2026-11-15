// Longer routes can contain sparsely mapped straight highways; keep urban limits unchanged.
export function maximumGeometrySegmentMeters(routeDistanceMeters, configuredLimit = 2_000) {
  return Math.max(configuredLimit, Math.min(10_000, routeDistanceMeters * 0.005));
}
