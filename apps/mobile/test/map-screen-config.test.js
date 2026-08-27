import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('map screen configuration', () => {
  it('allows zooming out to the global map', () => {
    const mapScreen = readFileSync(
      resolve(import.meta.dirname, '..', 'src/features/map/map-screen.tsx'),
      'utf8',
    );

    expect(mapScreen).toContain('minZoom={0}');
    expect(mapScreen).not.toContain('minZoom={8}');
  });

  it('loads Calgary overlays only for a known Calgary location', () => {
    const mapScreen = readFileSync(
      resolve(import.meta.dirname, '..', 'src/features/map/map-screen.tsx'),
      'utf8',
    );

    expect(mapScreen).toMatch(/mapRegion === 'calgary-ab'\s+\? 'calgary'/);
    expect(mapScreen).toContain(
      'if (!mapPreferences.showRoadEvents || roadEventRegion === undefined)',
    );
    expect(mapScreen).toContain("if (mapRegion !== 'calgary-ab')");
    expect(mapScreen).not.toContain(": 'calgary';");
  });

  it('requires a current supported coordinate for search and refreshes idle regional context', () => {
    const mapScreen = readFileSync(
      resolve(import.meta.dirname, '..', 'src/features/map/map-screen.tsx'),
      'utf8',
    );

    expect(mapScreen).toContain('const searchEnabled = true;');
    expect(mapScreen).toContain('const nearbySearchEnabled = searchOrigin !== undefined;');
    expect(mapScreen).toContain('Location.watchPositionAsync(');
    // The idle map must not throttle by distance. A 25 m filter meant a parked or slow-moving
    // vehicle kept a stale dot, since Core Location only delivers once that much ground is
    // covered; a standalone harness measured 5 m yielding a 5030 ms median between fixes.
    expect(mapScreen).toContain('distanceInterval: 0');
    expect(mapScreen).not.toContain('distanceInterval: 25');
    expect(mapScreen).toMatch(
      /useEffect\(\(\) => \{\s+if \(isCarPlayVisualHarness\(\)\) return;\s+let active = true;/,
    );
    expect(mapScreen).toContain('if (isCarPlayVisualHarness()) return null;');
    expect(mapScreen).toContain("locationState !== 'visible' || routeState.type !== 'idle'");
  });
});
