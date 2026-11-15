import {
  createServiceCoverage,
  DEFAULT_SERVICE_AREA_IDS,
  parseServiceAreaIds,
  type ServiceCoverage,
} from '@navoss/contracts';

/** The deployed Alberta+BC coverage, used when `NAVOSS_SERVICE_AREAS` is not set. */
export const DEFAULT_SERVICE_COVERAGE: ServiceCoverage =
  createServiceCoverage(DEFAULT_SERVICE_AREA_IDS);

const DATASET_VERSION = /^([a-z][a-z0-9-]*)-geofabrik-\d{4}-\d{2}-\d{2}$/u;

/**
 * The provinces this server declares, from `NAVOSS_SERVICE_AREAS` (comma-separated registry ids,
 * default `alberta,british-columbia`). It fails closed, refusing to start the API:
 *
 * - on an empty, unknown or repeated id; and
 * - with production search (`NOMINATIM_URL`), unless `NOMINATIM_DATASET_VERSION` is
 *   `<region>-geofabrik-<YYYY-MM-DD>` and `<region>` is `canada` or names every declared province,
 *   so a province is never declared over a search index imported without it.
 *
 * Declaring fewer provinces than the data holds is allowed: requests outside the declared
 * provinces are refused and results outside them are dropped.
 */
export function serviceCoverageFromEnvironment(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): ServiceCoverage {
  const coverage = createServiceCoverage(parseServiceAreaIds(environment.NAVOSS_SERVICE_AREAS));
  if (environment.NOMINATIM_URL === undefined) return coverage;
  const datasetVersion = environment.NOMINATIM_DATASET_VERSION ?? '';
  const region = DATASET_VERSION.exec(datasetVersion)?.[1];
  if (region === undefined) {
    throw new Error(
      'NOMINATIM_DATASET_VERSION must be <region>-geofabrik-<YYYY-MM-DD> when NOMINATIM_URL is set.',
    );
  }
  // `canada` is the whole-country Geofabrik extract; regional imports name each province.
  const missing =
    region === 'canada'
      ? []
      : coverage.areas.filter(({ id }) => !`-${region}-`.includes(`-${id}-`));
  if (missing.length > 0) {
    throw new Error(
      `NOMINATIM_DATASET_VERSION ${datasetVersion} does not include ${missing
        .map(({ id }) => id)
        .join(', ')}; declare only provinces the search index was imported with.`,
    );
  }
  return coverage;
}
