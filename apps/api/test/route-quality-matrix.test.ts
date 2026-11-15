import { fixtureValue } from '../../../packages/contracts/test/fixture-value.js';
import {
  CoordinateSchema,
  createServiceCoverage,
  PROVINCE_REGISTRY,
  provinceForCoordinate,
  REGISTERED_SERVICE_AREAS,
} from '@navoss/contracts';
import { describe, expect, it } from 'vitest';
import matrix from '../scripts/route-quality-alberta-bc.json' with { type: 'json' };
import canadaMatrix from '../scripts/route-quality-canada.json' with { type: 'json' };
describe('public Alberta and BC route-quality matrix', () => {
  it('has 22 directed routes with every requested city and an inter-provincial corridor', () => {
    expect(matrix.routePath).toBe('/v2/routes');
    expect(matrix.corridors.length * 2).toBe(matrix.expectedCaseCount);
    const tags = new Set(matrix.corridors.flatMap((corridor) => corridor.tags));
    for (const city of [
      'edmonton',
      'red-deer',
      'lethbridge',
      'banff',
      'vancouver',
      'victoria',
      'kelowna',
      'kamloops',
      'prince-george',
    ])
      expect(tags.has(city)).toBe(true);
    const corridor = fixtureValue(matrix.corridors.find(({ id }) => id === 'calgary-vancouver'));
    const anchors: Record<
      string,
      {
        coordinate: {
          latitude: number;
          longitude: number;
        };
      }
    > = matrix.anchors;
    expect(
      provinceForCoordinate(fixtureValue(anchors[corridor.originAnchorId]).coordinate)?.area.id,
    ).toBe('alberta');
    expect(
      provinceForCoordinate(fixtureValue(anchors[corridor.destinationAnchorId]).coordinate)?.area
        .id,
    ).toBe('british-columbia');
  });
  it('uses valid, in-coverage public anchors and no missing corridor references', () => {
    const anchors: Record<
      string,
      {
        coordinate: {
          latitude: number;
          longitude: number;
        };
        sourceUrl: string;
      }
    > = matrix.anchors;
    for (const anchor of Object.values(anchors)) {
      expect(CoordinateSchema.safeParse(anchor.coordinate).success).toBe(true);
      expect(provinceForCoordinate(anchor.coordinate)).toBeDefined();
      expect(anchor.sourceUrl.startsWith('https://www.openstreetmap.org/')).toBe(true);
    }
    for (const corridor of matrix.corridors) {
      expect(anchors[corridor.originAnchorId]).toBeDefined();
      expect(anchors[corridor.destinationAnchorId]).toBeDefined();
      expect(corridor.distanceRangeKm[0]).toBeLessThan(fixtureValue(corridor.distanceRangeKm[1]));
    }
  });
});

describe('public Canada route-quality matrix', () => {
  const canada = createServiceCoverage(REGISTERED_SERVICE_AREAS.map(({ id }) => id));
  const anchors: Record<string, { coordinate: { latitude: number; longitude: number } }> =
    canadaMatrix.anchors;
  const provinceOf = (anchorId: string) =>
    provinceForCoordinate(fixtureValue(anchors[anchorId]).coordinate)?.area.id;

  it('keeps the Alberta+BC 22 unchanged and runs both directions of every corridor', () => {
    expect(canadaMatrix.routePath).toBe('/v2/routes');
    expect(canadaMatrix.corridors.length * 2).toBe(canadaMatrix.expectedCaseCount);
    expect(canadaMatrix.benchmarkId).toBe(`canada-${String(canadaMatrix.expectedCaseCount)}`);
    expect(canadaMatrix.corridors.slice(0, matrix.corridors.length)).toEqual(matrix.corridors);
    for (const [id, anchor] of Object.entries(matrix.anchors)) {
      expect((canadaMatrix.anchors as Record<string, unknown>)[id]).toEqual(anchor);
    }
  });

  it('covers every requested city, region and inter-provincial stress case', () => {
    const tags = new Set(canadaMatrix.corridors.flatMap((corridor) => corridor.tags));
    for (const tag of [
      'toronto',
      'ottawa',
      'hamilton',
      'london',
      'windsor',
      'sudbury',
      'thunder-bay',
      'montreal',
      'quebec-city',
      'gatineau',
      'sherbrooke',
      'regina',
      'saskatoon',
      'winnipeg',
      'halifax',
      'moncton',
      'saint-john',
      'charlottetown',
      'st-johns',
      'whitehorse',
      'yellowknife',
      'ferry',
      'stress',
      '400-series',
      'autoroute',
    ])
      expect(tags.has(tag), tag).toBe(true);
    const ids = new Set(canadaMatrix.corridors.map(({ id }) => id));
    for (const id of ['calgary-winnipeg', 'toronto-montreal', 'vancouver-toronto-stress'])
      expect(ids.has(id), id).toBe(true);
    const provinces = new Set(Object.keys(anchors).map((id) => provinceOf(id)));
    for (const { area } of PROVINCE_REGISTRY.filter(({ connectsTo }) => connectsTo.length > 0))
      expect(provinces.has(area.id), area.id).toBe(true);
  });

  it('only pairs places a road (or a scheduled ferry) can connect, inside their tagged provinces', () => {
    for (const corridor of canadaMatrix.corridors) {
      const origin = fixtureValue(anchors[corridor.originAnchorId]).coordinate;
      const destination = fixtureValue(anchors[corridor.destinationAnchorId]).coordinate;
      expect(canada.disconnectedAreas([origin, destination]), corridor.id).toBeUndefined();
      for (const anchorId of [corridor.originAnchorId, corridor.destinationAnchorId]) {
        const province = provinceOf(anchorId);
        expect(province, anchorId).toBeDefined();
        expect(corridor.tags, `${corridor.id} ${anchorId}`).toContain(province);
      }
      const [minimumKm, maximumKm] = corridor.distanceRangeKm;
      expect(minimumKm).toBeLessThan(fixtureValue(maximumKm));
    }
    const ferry = fixtureValue(
      canadaMatrix.corridors.find(({ id }) => id === 'halifax-st-johns-ferry'),
    );
    expect(ferry.maximumSegmentMeters).toBeGreaterThanOrEqual(100_000);
    const stress = fixtureValue(
      canadaMatrix.corridors.find(({ id }) => id === 'vancouver-toronto-stress'),
    );
    expect('maximumLatencyMs' in stress && stress.maximumLatencyMs).toBeGreaterThan(5_000);
  });

  it('has a corridor inside every province with roads, for a declaration of that province alone', () => {
    // check-coverage.sh routes this corridor; only Nunavut, with no road between communities, has none.
    for (const { area, connectsTo } of PROVINCE_REGISTRY) {
      const inside = canadaMatrix.corridors.filter(
        (corridor) =>
          provinceOf(corridor.originAnchorId) === area.id &&
          provinceOf(corridor.destinationAnchorId) === area.id &&
          !corridor.tags.includes('inter-provincial'),
      );
      expect(inside.length > 0, area.id).toBe(connectsTo.length > 0);
    }
  });
});
