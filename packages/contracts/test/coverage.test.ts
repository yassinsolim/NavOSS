import { describe, expect, it } from 'vitest';

import {
  CoverageBoundarySchema,
  isCoordinateInBoundary,
  isCoordinateInBounds,
  isCoordinateInServiceCoverage,
  LOCAL_OVERLAY_AREAS,
  SERVICE_AREAS,
  ServiceAreaSchema,
  serviceAreaForCoordinate,
} from '../src/index.js';
import borderPoints from './fixtures/coverage-border-points.json' with { type: 'json' };

describe('provincial service coverage', () => {
  it.each(borderPoints.cases)(
    '$id follows the sourced province boundary',
    ({ coordinate, serviceAreaId }) => {
      expect(serviceAreaForCoordinate(coordinate)?.id ?? null).toBe(serviceAreaId);
      expect(isCoordinateInServiceCoverage(coordinate)).toBe(serviceAreaId !== null);
    },
  );

  it('validates each sourced area and includes its recorded boundary vertices', () => {
    for (const area of SERVICE_AREAS) {
      expect(ServiceAreaSchema.safeParse(area).success).toBe(true);
      const [longitude, latitude] = area.boundary.coordinates[0]![0]![0]!;
      expect(isCoordinateInBoundary({ latitude, longitude }, area.boundary)).toBe(true);
    }
  });

  it('does not authorize foreign points just because they fit the BC retrieval envelope', () => {
    const bc = SERVICE_AREAS.find(({ id }) => id === 'british-columbia')!;
    for (const id of ['point-roberts-outside', 'san-juan-island-outside', 'hyder-alaska-outside']) {
      const { coordinate } = borderPoints.cases.find((entry) => entry.id === id)!;
      expect(isCoordinateInBounds(coordinate, bc.bounds)).toBe(true);
      expect(isCoordinateInBoundary(coordinate, bc.boundary)).toBe(false);
    }
  });

  it('keeps municipal overlays local after the province expansion', () => {
    const calgary = LOCAL_OVERLAY_AREAS.find(({ id }) => id === 'calgary-ab')!;
    const kelowna = LOCAL_OVERLAY_AREAS.find(({ id }) => id === 'kelowna-bc')!;
    expect(calgary.scope).toBe('local-overlay');
    expect(kelowna.scope).toBe('local-overlay');
    expect(calgary.services).toContain('civic-search');
    expect(kelowna.services).not.toContain('civic-search');
    expect(isCoordinateInBounds({ latitude: 53.5461, longitude: -113.4938 }, calgary.bounds)).toBe(
      false,
    );
    expect(isCoordinateInBounds({ latitude: 49.2827, longitude: -123.1207 }, kelowna.bounds)).toBe(
      false,
    );
  });

  it('accepts a data-defined area id instead of a fixed two-province tuple', () => {
    expect(
      ServiceAreaSchema.safeParse({
        ...SERVICE_AREAS[0],
        id: 'another-province',
        displayName: 'Another province',
        provinceCode: 'XX',
      }).success,
    ).toBe(true);
    expect(
      ServiceAreaSchema.safeParse({
        bounds: SERVICE_AREAS[0]!.bounds,
        id: 'alberta',
        displayName: 'Alberta',
        countryCode: 'CA',
        provinceCode: 'AB',
      }).success,
    ).toBe(false);
  });

  it('handles multipolygons and holes and rejects an unclosed ring', () => {
    const boundary = CoverageBoundarySchema.parse({
      type: 'MultiPolygon',
      coordinates: [
        [
          [
            [0, 0],
            [4, 0],
            [4, 4],
            [0, 4],
            [0, 0],
          ],
          [
            [1, 1],
            [1, 2],
            [2, 2],
            [2, 1],
            [1, 1],
          ],
        ],
        [
          [
            [10, 10],
            [11, 10],
            [11, 11],
            [10, 11],
            [10, 10],
          ],
        ],
      ],
    });
    expect(isCoordinateInBoundary({ latitude: 3, longitude: 3 }, boundary)).toBe(true);
    expect(isCoordinateInBoundary({ latitude: 1.5, longitude: 1.5 }, boundary)).toBe(false);
    expect(isCoordinateInBoundary({ latitude: 10.5, longitude: 10.5 }, boundary)).toBe(true);
    expect(isCoordinateInBoundary({ latitude: 6, longitude: 6 }, boundary)).toBe(false);
    expect(
      CoverageBoundarySchema.safeParse({
        type: 'MultiPolygon',
        coordinates: [
          [
            [
              [0, 0],
              [1, 0],
              [1, 1],
              [0, 1],
            ],
          ],
        ],
      }).success,
    ).toBe(false);
  });
});
