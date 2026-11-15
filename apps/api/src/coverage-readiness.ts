import { PROVINCE_REGISTRY, type ServiceArea, type ServiceCoverage } from '@navoss/contracts';
import { z } from 'zod/v4';

const PROBE_TIMEOUT_MS = 3_000;

const ValhallaLocateSchema = z.array(
  z.object({ edges: z.array(z.unknown()).nullable().optional() }).loose(),
);
const NominatimReverseSchema = z.object({
  address: z.record(z.string(), z.string()).optional(),
});

/** Whether the installed routing graph and search index hold every declared province. */
export interface CoverageReadiness {
  /** Display names of declared provinces whose data did not answer, in registry order. */
  missingAreas(): Promise<string[]>;
}

export interface CoverageReadinessOptions {
  fetchImplementation?: typeof fetch;
  /** Valhalla's `/locate` endpoint. */
  locateUrl?: string;
  /** Nominatim's base URL; its `/reverse` must name the province (ISO 3166-2). */
  nominatimUrl?: string;
}

/**
 * Asks the graph and the index about each declared province at its fixed public probe point (no
 * user data): Valhalla must find a road edge there and Nominatim must place the point in that
 * province. A province declared over data imported without it makes `/ready` fail.
 */
export function createCoverageReadiness(
  coverage: ServiceCoverage,
  options: CoverageReadinessOptions,
): CoverageReadiness {
  const fetchImplementation = options.fetchImplementation ?? fetch;
  const probes = coverage.areas.map((area) => {
    const registration = PROVINCE_REGISTRY.find((entry) => entry.area.id === area.id);
    if (registration === undefined) throw new Error(`Service area ${area.id} is not registered.`);
    return { area, probe: registration.readinessProbe };
  });

  async function hasRoad(probe: { latitude: number; longitude: number }): Promise<boolean> {
    if (options.locateUrl === undefined) return true;
    const response = await fetchImplementation(options.locateUrl, {
      body: JSON.stringify({
        costing: 'auto',
        locations: [{ lat: probe.latitude, lon: probe.longitude }],
      }),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    if (!response.ok) return false;
    const parsed = ValhallaLocateSchema.safeParse(await response.json());
    return parsed.success && (parsed.data[0]?.edges?.length ?? 0) > 0;
  }

  async function hasPlace(
    area: ServiceArea,
    probe: { latitude: number; longitude: number },
  ): Promise<boolean> {
    if (options.nominatimUrl === undefined) return true;
    const base = options.nominatimUrl.endsWith('/')
      ? options.nominatimUrl
      : `${options.nominatimUrl}/`;
    const url = new URL('reverse', base);
    url.searchParams.set('addressdetails', '1');
    url.searchParams.set('format', 'jsonv2');
    url.searchParams.set('lat', String(probe.latitude));
    url.searchParams.set('lon', String(probe.longitude));
    url.searchParams.set('zoom', '10');
    const response = await fetchImplementation(url, {
      headers: { accept: 'application/json', 'user-agent': 'NavOSS/0.1' },
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    if (!response.ok) return false;
    const parsed = NominatimReverseSchema.safeParse(await response.json());
    return (
      parsed.success &&
      parsed.data.address?.['ISO3166-2-lvl4'] === `${area.countryCode}-${area.provinceCode}`
    );
  }

  return {
    async missingAreas() {
      const answered = await Promise.all(
        probes.map(async ({ area, probe }) => {
          try {
            const [road, place] = await Promise.all([hasRoad(probe), hasPlace(area, probe)]);
            return road && place;
          } catch {
            return false;
          }
        }),
      );
      return probes.filter((_, index) => !answered[index]).map(({ area }) => area.displayName);
    },
  };
}

/** Built from the production environment; absent when neither data service is configured. */
export function createConfiguredCoverageReadiness(
  coverage: ServiceCoverage,
  environment: Readonly<Record<string, string | undefined>> = process.env,
): CoverageReadiness | undefined {
  const statusUrl = environment.VALHALLA_STATUS_URL;
  const locateUrl = statusUrl === undefined ? undefined : new URL('locate', statusUrl).toString();
  const nominatimUrl = environment.NOMINATIM_URL;
  if (locateUrl === undefined && nominatimUrl === undefined) return undefined;
  return createCoverageReadiness(coverage, {
    ...(locateUrl === undefined ? {} : { locateUrl }),
    ...(nominatimUrl === undefined ? {} : { nominatimUrl }),
  });
}
