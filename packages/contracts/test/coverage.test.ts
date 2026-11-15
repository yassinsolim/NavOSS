import { fixtureValue } from './fixture-value.js';
import { describe, expect, it } from 'vitest';
import {
  CoverageBoundarySchema,
  createServiceCoverage,
  DEFAULT_SERVICE_AREA_IDS,
  isCoordinateInBoundary,
  isCoordinateInBounds,
  LOCAL_OVERLAY_AREAS,
  parseServiceAreaIds,
  PROVINCE_REGISTRY,
  provinceForCoordinate,
  provinceTimeZone,
  REGISTERED_SERVICE_AREAS,
  ServiceAreaSchema,
} from '../src/index.js';
import borderPoints from './fixtures/coverage-border-points.json' with { type: 'json' };
const DEFAULT = createServiceCoverage(DEFAULT_SERVICE_AREA_IDS);
const coordinateOf = (id: string) =>
  fixtureValue(borderPoints.cases.find((entry) => entry.id === id)).coordinate;

describe('province registry', () => {
  it.each(borderPoints.cases)(
    '$id lies in the sourced boundary of $provinceId',
    ({ coordinate, provinceId }) => {
      expect(provinceForCoordinate(coordinate)?.area.id ?? null).toBe(provinceId);
    },
  );

  it('registers all ten provinces and three territories once, from one source', () => {
    expect(PROVINCE_REGISTRY.map(({ area }) => area.provinceCode).sort()).toEqual([
      'AB',
      'BC',
      'MB',
      'NB',
      'NL',
      'NS',
      'NT',
      'NU',
      'ON',
      'PE',
      'QC',
      'SK',
      'YT',
    ]);
    expect(new Set(REGISTERED_SERVICE_AREAS.map(({ id }) => id)).size).toBe(13);
  });

  it('declares only symmetric, registered road connections', () => {
    for (const { area, connectsTo } of PROVINCE_REGISTRY) {
      for (const neighbour of connectsTo) {
        const other = PROVINCE_REGISTRY.find((entry) => entry.area.id === neighbour);
        expect(other?.connectsTo, `${area.id} -> ${neighbour}`).toContain(area.id);
      }
    }
  });

  it('places every readiness probe inside its own province', () => {
    for (const { area, readinessProbe } of PROVINCE_REGISTRY) {
      expect(provinceForCoordinate(readinessProbe)?.area.id).toBe(area.id);
    }
  });

  it.each([
    ['calgary', 'America/Edmonton'],
    ['toronto', 'America/Toronto'],
    ['thunder-bay', 'America/Toronto'],
    ['kenora', undefined],
    ['moosonee', undefined],
    ['montreal', 'America/Toronto'],
    ['magdalen-islands', undefined],
    ['winnipeg', 'America/Winnipeg'],
    ['regina', 'America/Regina'],
    ['lloydminster-sk', undefined],
    ['lloydminster-ab', 'America/Edmonton'],
    ['halifax', 'America/Halifax'],
    ['charlottetown', 'America/Halifax'],
    ['moncton', 'America/Moncton'],
    ['st-johns', 'America/St_Johns'],
    ['labrador-city', undefined],
    ['whitehorse', 'America/Whitehorse'],
    ['yellowknife', 'America/Edmonton'],
    ['iqaluit', undefined],
    ['vancouver', undefined],
    ['detroit', undefined],
  ])('gives %s the time zone that is certain there (%s)', (id, timeZone) => {
    expect(provinceTimeZone(coordinateOf(id))).toBe(timeZone);
  });
});

describe('declared service coverage', () => {
  it('keeps the deployed Alberta+BC declaration by default', () => {
    expect(parseServiceAreaIds(undefined)).toEqual(['alberta', 'british-columbia']);
    expect(DEFAULT.id).toBe('alberta-british-columbia');
    expect(DEFAULT.displayName).toBe('Alberta and British Columbia');
    expect(DEFAULT.areas).toEqual(REGISTERED_SERVICE_AREAS.slice(0, 2));
    for (const { coordinate, provinceId } of borderPoints.cases) {
      const served = provinceId === 'alberta' || provinceId === 'british-columbia';
      expect(DEFAULT.areaForCoordinate(coordinate)?.id ?? null).toBe(served ? provinceId : null);
      expect(DEFAULT.contains(coordinate)).toBe(served);
    }
  });

  it('serves Ontario only when declared, and names coverage in registry order', () => {
    const coverage = createServiceCoverage(['ontario', 'alberta', 'british-columbia']);
    expect(coverage.id).toBe('alberta-british-columbia-ontario');
    expect(coverage.displayName).toBe('Alberta, British Columbia and Ontario');
    for (const id of [
      'toronto',
      'pelee-island',
      'manitoulin-island',
      'windsor',
      'ottawa-parliament',
    ]) {
      expect(DEFAULT.contains(coordinateOf(id)), id).toBe(false);
      expect(coverage.contains(coordinateOf(id)), id).toBe(true);
    }
    for (const id of ['detroit', 'gatineau-museum', 'sault-ste-marie-mi', 'niagara-falls-ny']) {
      expect(coverage.contains(coordinateOf(id)), id).toBe(false);
    }
    expect(createServiceCoverage(['ontario']).displayName).toBe('Ontario');
  });

  it('calls every registered province Canada', () => {
    const canada = createServiceCoverage(REGISTERED_SERVICE_AREAS.map(({ id }) => id));
    expect(canada.id).toBe('canada');
    expect(canada.displayName).toBe('Canada');
    expect(canada.contains(coordinateOf('iqaluit'))).toBe(true);
    expect(canada.contains(coordinateOf('saint-pierre-france'))).toBe(false);
  });

  it.each([
    [[], /At least one/],
    [['alberta', 'alberta'], /declared twice/],
    [['alberta', 'atlantis'], /not in the province registry/],
    [[''], /not in the province registry/],
  ])('fails closed for %j', (ids, message) => {
    expect(() => createServiceCoverage(ids)).toThrow(message);
  });

  it('reads a comma-separated declaration without guessing', () => {
    expect(parseServiceAreaIds(' alberta, ontario ')).toEqual(['alberta', 'ontario']);
    expect(() => createServiceCoverage(parseServiceAreaIds(''))).toThrow();
  });

  it('finds provinces no declared road connects', () => {
    const western = ['alberta', 'british-columbia'];
    const withOntario = createServiceCoverage([...western, 'ontario']);
    const path = [coordinateOf('calgary'), coordinateOf('vancouver')];
    expect(withOntario.disconnectedAreas(path)).toBeUndefined();
    const gap = withOntario.disconnectedAreas([coordinateOf('vancouver'), coordinateOf('toronto')]);
    expect([gap?.from.id, gap?.to.id]).toEqual(['british-columbia', 'ontario']);
    const prairies = createServiceCoverage([...western, 'saskatchewan', 'manitoba', 'ontario']);
    expect(
      prairies.disconnectedAreas([coordinateOf('calgary'), coordinateOf('toronto')]),
    ).toBeUndefined();
    const canada = createServiceCoverage(REGISTERED_SERVICE_AREAS.map(({ id }) => id));
    expect(
      canada.disconnectedAreas([coordinateOf('vancouver'), coordinateOf('st-johns')]),
    ).toBeUndefined();
    expect(
      canada.disconnectedAreas([coordinateOf('whitehorse'), coordinateOf('inuvik')]),
    ).toBeUndefined();
    expect(
      canada.disconnectedAreas([coordinateOf('yellowknife'), coordinateOf('iqaluit')])?.to.id,
    ).toBe('nunavut');
    // Newfoundland is reached through Nova Scotia (ferry) or Quebec (Labrador); not from New Brunswick alone.
    const atlantic = createServiceCoverage(['new-brunswick', 'newfoundland-and-labrador']);
    expect(
      atlantic.disconnectedAreas([coordinateOf('moncton'), coordinateOf('st-johns')]),
    ).toBeDefined();
  });
});

describe('sourced boundaries', () => {
  it('validates each sourced area and includes its recorded boundary vertices', () => {
    for (const area of REGISTERED_SERVICE_AREAS) {
      expect(ServiceAreaSchema.safeParse(area).success).toBe(true);
      const [longitude, latitude] = fixtureValue(
        fixtureValue(fixtureValue(area.boundary.coordinates[0])[0])[0],
      );
      expect(isCoordinateInBoundary({ latitude, longitude }, area.boundary)).toBe(true);
    }
  });
  it('does not authorize foreign points just because they fit the BC retrieval envelope', () => {
    const bc = fixtureValue(REGISTERED_SERVICE_AREAS.find(({ id }) => id === 'british-columbia'));
    for (const id of ['point-roberts-outside', 'san-juan-island-outside', 'hyder-alaska-outside']) {
      const coordinate = coordinateOf(id);
      expect(isCoordinateInBounds(coordinate, bc.bounds)).toBe(true);
      expect(isCoordinateInBoundary(coordinate, bc.boundary)).toBe(false);
    }
  });
  it('keeps municipal overlays local after the province expansion', () => {
    const calgary = fixtureValue(LOCAL_OVERLAY_AREAS.find(({ id }) => id === 'calgary-ab'));
    const kelowna = fixtureValue(LOCAL_OVERLAY_AREAS.find(({ id }) => id === 'kelowna-bc'));
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
        ...REGISTERED_SERVICE_AREAS[0],
        id: 'another-province',
        displayName: 'Another province',
        provinceCode: 'XX',
      }).success,
    ).toBe(true);
    expect(
      ServiceAreaSchema.safeParse({
        bounds: fixtureValue(REGISTERED_SERVICE_AREAS[0]).bounds,
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
