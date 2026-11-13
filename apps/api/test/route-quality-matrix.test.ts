import { fixtureValue } from '../../../packages/contracts/test/fixture-value.js';
import { CoordinateSchema, serviceAreaForCoordinate } from '@navoss/contracts';
import { describe, expect, it } from 'vitest';
import matrix from '../scripts/route-quality-alberta-bc.json' with { type: 'json' };
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
      serviceAreaForCoordinate(fixtureValue(anchors[corridor.originAnchorId]).coordinate)?.id,
    ).toBe('alberta');
    expect(
      serviceAreaForCoordinate(fixtureValue(anchors[corridor.destinationAnchorId]).coordinate)?.id,
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
      expect(serviceAreaForCoordinate(anchor.coordinate)).toBeDefined();
      expect(anchor.sourceUrl.startsWith('https://www.openstreetmap.org/')).toBe(true);
    }
    for (const corridor of matrix.corridors) {
      expect(anchors[corridor.originAnchorId]).toBeDefined();
      expect(anchors[corridor.destinationAnchorId]).toBeDefined();
      expect(corridor.distanceRangeKm[0]).toBeLessThan(fixtureValue(corridor.distanceRangeKm[1]));
    }
  });
});
