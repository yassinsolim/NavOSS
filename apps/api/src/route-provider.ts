import { createHash } from 'node:crypto';

import {
  compareRouteAlternatives,
  RoutePositionSchema,
  type RouteAlternative,
  type RouteRequest,
} from '@navoss/contracts';
import { z } from 'zod/v4';

const DEFAULT_VALHALLA_URL = 'https://valhalla1.openstreetmap.de/route';
const DEFAULT_MAPBOX_TRAFFIC_URL = 'https://api.mapbox.com/directions/v5/mapbox/driving-traffic';
const ROUTE_TIMEOUT_MS = 8_000;

const ValhallaStepSchema = z.object({
  distance: z.number().nonnegative(),
  duration: z.number().nonnegative(),
  geometry: z.object({
    coordinates: z.array(RoutePositionSchema).min(2),
    type: z.literal('LineString'),
  }),
  maneuver: z.object({
    instruction: z.string().min(1),
    type: z.string().min(1),
  }),
  name: z.string(),
  voiceInstructions: z
    .array(
      z.object({
        announcement: z.string().min(1),
      }),
    )
    .optional(),
});

const ValhallaResponseSchema = z.object({
  code: z.literal('Ok'),
  routes: z
    .array(
      z.object({
        distance: z.number().positive(),
        duration: z.number().positive(),
        geometry: z.object({
          coordinates: z.array(RoutePositionSchema).min(2),
          type: z.literal('LineString'),
        }),
        legs: z.array(z.object({ steps: z.array(ValhallaStepSchema).min(1) })).min(1),
      }),
    )
    .min(1),
});

const MapboxTrafficResponseSchema = z.object({
  code: z.literal('Ok'),
  routes: z
    .array(
      z.object({
        distance: z.number().positive(),
        duration: z.number().positive(),
        duration_typical: z.number().positive(),
        geometry: z.object({
          coordinates: z.array(RoutePositionSchema).min(2),
          type: z.literal('LineString'),
        }),
        legs: z.array(z.object({ steps: z.array(ValhallaStepSchema).min(1) })).min(1),
      }),
    )
    .min(1),
});

export class RouteProviderError extends Error {
  public constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'RouteProviderError';
  }
}

export interface RouteProvider {
  getRoutes(request: RouteRequest): Promise<RouteAlternative[]>;
  isReady?(): Promise<boolean>;
  source?: {
    attribution: 'Routing and traffic by Mapbox' | 'Routing by Valhalla using OpenStreetMap data';
    degraded: boolean;
    id: 'mapbox-traffic' | 'valhalla-development' | 'valhalla-self-hosted';
    mode: 'development' | 'production';
    traffic: 'live' | 'unavailable';
  };
}

export interface MapboxTrafficRouteProviderOptions {
  accessToken: string;
  clock?: () => number;
  endpoint?: string;
  fetchImplementation?: typeof fetch;
  now?: () => Date;
  readinessCacheMs?: number;
  vehicleLicenseConfirmed: boolean;
}

export function createConfiguredRouteProvider(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): RouteProvider {
  const configuredToken = environment.MAPBOX_ACCESS_TOKEN?.trim();
  const accessToken = configuredToken === '' ? undefined : configuredToken;
  const vehicleLicenseConfirmed = environment.MAPBOX_VEHICLE_LICENSE_CONFIRMED === '1';
  if (accessToken !== undefined || vehicleLicenseConfirmed) {
    return createMapboxTrafficRouteProvider({
      accessToken: accessToken ?? '',
      vehicleLicenseConfirmed,
    });
  }
  return createValhallaRouteProvider();
}

export interface ValhallaRouteProviderOptions {
  endpoint?: string;
  fetchImplementation?: typeof fetch;
  readinessEndpoint?: string;
}

function buildValhallaRequest(request: RouteRequest): unknown {
  return {
    alternates: request.alternatives,
    banner_instructions: true,
    costing: 'auto',
    costing_options: {
      auto: {
        exclude_unpaved: request.preferences.avoidUnpaved,
        use_ferry: request.preferences.avoidFerries ? 0 : 0.5,
        use_highways: request.preferences.avoidHighways ? 0 : 0.5,
        use_tolls: request.preferences.avoidTolls ? 0 : 0.5,
      },
    },
    format: 'osrm',
    language: 'en-US',
    locations: [
      { lat: request.origin.latitude, lon: request.origin.longitude },
      { lat: request.destination.latitude, lon: request.destination.longitude },
    ],
    shape_format: 'geojson',
    turn_lanes: true,
    units: 'kilometers',
    voice_instructions: true,
  };
}

function normalizeRoutes(payload: z.infer<typeof ValhallaResponseSchema>): RouteAlternative[] {
  return payload.routes
    .map((route, index) => ({
      distanceMeters: route.distance,
      durationSeconds: route.duration,
      geometry: route.geometry.coordinates,
      id: `valhalla-${String(index + 1)}-${createHash('sha256')
        .update(JSON.stringify(route))
        .digest('hex')
        .slice(0, 16)}`,
      label: 'alternative' as const,
      steps: route.legs.flatMap((leg) =>
        leg.steps.map((step) => {
          const spokenInstruction = step.voiceInstructions?.at(-1)?.announcement;
          return {
            distanceMeters: step.distance,
            durationSeconds: step.duration,
            geometry: step.geometry.coordinates,
            instruction: step.maneuver.instruction,
            maneuverType: step.maneuver.type,
            roadName: step.name,
            ...(spokenInstruction === undefined ? {} : { spokenInstruction }),
          };
        }),
      ),
    }))
    .sort(compareRouteAlternatives)
    .map((route, index) => ({
      ...route,
      label: index === 0 ? ('fastest' as const) : ('alternative' as const),
    }));
}

function buildMapboxTrafficUrl(
  request: RouteRequest,
  endpoint: string,
  accessToken: string,
  departureTime: Date,
): URL {
  const coordinates = [request.origin, request.destination]
    .map(({ latitude, longitude }) => `${String(longitude)},${String(latitude)}`)
    .join(';');
  const url = new URL(`${endpoint.replace(/\/$/, '')}/${coordinates}`);
  const exclusions = [
    ...(request.preferences.avoidFerries ? ['ferry'] : []),
    ...(request.preferences.avoidHighways ? ['motorway'] : []),
    ...(request.preferences.avoidTolls ? ['toll'] : []),
    ...(request.preferences.avoidUnpaved ? ['unpaved'] : []),
  ];
  url.searchParams.set('access_token', accessToken);
  url.searchParams.set('alternatives', request.alternatives > 0 ? 'true' : 'false');
  url.searchParams.set('banner_instructions', 'true');
  url.searchParams.set('depart_at', departureTime.toISOString());
  url.searchParams.set('geometries', 'geojson');
  url.searchParams.set('language', 'en');
  url.searchParams.set('overview', 'full');
  url.searchParams.set('steps', 'true');
  url.searchParams.set('voice_instructions', 'true');
  url.searchParams.set('voice_units', 'metric');
  url.searchParams.set('waypoints_per_route', 'true');
  if (exclusions.length > 0) {
    url.searchParams.set('exclude', exclusions.join(','));
  }
  return url;
}

function normalizeMapboxTrafficRoutes(
  payload: z.infer<typeof MapboxTrafficResponseSchema>,
): RouteAlternative[] {
  return payload.routes
    .map((route, index) => ({
      distanceMeters: route.distance,
      durationSeconds: route.duration,
      geometry: route.geometry.coordinates,
      id: `mapbox-${String(index + 1)}-${createHash('sha256')
        .update(JSON.stringify(route))
        .digest('hex')
        .slice(0, 16)}`,
      label: 'alternative' as const,
      steps: route.legs.flatMap((leg) =>
        leg.steps.map((step) => {
          const spokenInstruction = step.voiceInstructions?.at(-1)?.announcement;
          return {
            distanceMeters: step.distance,
            durationSeconds: step.duration,
            geometry: step.geometry.coordinates,
            instruction: step.maneuver.instruction,
            maneuverType: step.maneuver.type,
            roadName: step.name,
            ...(spokenInstruction === undefined ? {} : { spokenInstruction }),
          };
        }),
      ),
      traffic: {
        delaySeconds: Math.max(0, route.duration - route.duration_typical),
        typicalDurationSeconds: route.duration_typical,
      },
    }))
    .sort(compareRouteAlternatives)
    .map((route, index) => ({
      ...route,
      label: index === 0 ? ('fastest' as const) : ('alternative' as const),
    }));
}

export function createMapboxTrafficRouteProvider(
  options: MapboxTrafficRouteProviderOptions,
): RouteProvider {
  const accessToken = options.accessToken.trim();
  if (!options.vehicleLicenseConfirmed) {
    throw new Error('Mapbox traffic routing requires a confirmed vehicle-use license.');
  }
  if (accessToken.length === 0) {
    throw new Error('A Mapbox access token is required for traffic routing.');
  }
  const endpoint = options.endpoint ?? DEFAULT_MAPBOX_TRAFFIC_URL;
  const fetchImplementation = options.fetchImplementation ?? fetch;
  const now = options.now ?? (() => new Date());
  const clock = options.clock ?? Date.now;
  const readinessCacheMs = options.readinessCacheMs ?? 5 * 60 * 1_000;
  let cachedReadiness: { expiresAt: number; value: boolean } | undefined;

  async function isReady(): Promise<boolean> {
    const currentTime = clock();
    if (cachedReadiness !== undefined && currentTime < cachedReadiness.expiresAt) {
      return cachedReadiness.value;
    }
    const readinessRequest: RouteRequest = {
      alternatives: 0,
      destination: { latitude: 51.0471, longitude: -114.0575 },
      origin: { latitude: 51.04427, longitude: -114.06309 },
      preferences: {
        avoidFerries: false,
        avoidHighways: false,
        avoidTolls: false,
        avoidUnpaved: false,
      },
    };
    let value = false;
    try {
      const response = await fetchImplementation(
        buildMapboxTrafficUrl(readinessRequest, endpoint, accessToken, now()),
        {
          headers: { accept: 'application/json' },
          signal: AbortSignal.timeout(3_000),
        },
      );
      if (response.ok) {
        const payload: unknown = await response.json();
        value = MapboxTrafficResponseSchema.safeParse(payload).success;
      }
    } catch {
      value = false;
    }
    cachedReadiness = { expiresAt: currentTime + readinessCacheMs, value };
    return value;
  }

  return {
    async getRoutes(request) {
      let response: Response;
      try {
        response = await fetchImplementation(
          buildMapboxTrafficUrl(request, endpoint, accessToken, now()),
          {
            headers: { accept: 'application/json' },
            signal: AbortSignal.timeout(ROUTE_TIMEOUT_MS),
          },
        );
      } catch (error: unknown) {
        throw new RouteProviderError('The traffic routing provider could not be reached.', {
          cause: error,
        });
      }
      if (!response.ok) {
        throw new RouteProviderError(
          `The traffic routing provider returned status ${String(response.status)}.`,
        );
      }
      let payload: unknown;
      try {
        payload = await response.json();
      } catch (error: unknown) {
        throw new RouteProviderError('The traffic routing provider returned invalid JSON.', {
          cause: error,
        });
      }
      const parsed = MapboxTrafficResponseSchema.safeParse(payload);
      if (!parsed.success) {
        throw new RouteProviderError('The traffic routing provider response failed validation.');
      }
      return normalizeMapboxTrafficRoutes(parsed.data);
    },
    isReady,
    source: {
      attribution: 'Routing and traffic by Mapbox',
      degraded: false,
      id: 'mapbox-traffic',
      mode: 'production',
      traffic: 'live',
    },
  };
}

export function createValhallaRouteProvider(
  options: ValhallaRouteProviderOptions = {},
): RouteProvider {
  const endpoint = options.endpoint ?? process.env.VALHALLA_URL ?? DEFAULT_VALHALLA_URL;
  const fetchImplementation = options.fetchImplementation ?? fetch;
  const readinessEndpoint = options.readinessEndpoint ?? process.env.VALHALLA_STATUS_URL;
  const development = endpoint === DEFAULT_VALHALLA_URL;

  return {
    async getRoutes(request) {
      let response: Response;

      try {
        response = await fetchImplementation(endpoint, {
          body: JSON.stringify(buildValhallaRequest(request)),
          headers: { 'content-type': 'application/json' },
          method: 'POST',
          signal: AbortSignal.timeout(ROUTE_TIMEOUT_MS),
        });
      } catch (error: unknown) {
        throw new RouteProviderError('The routing provider could not be reached.', {
          cause: error,
        });
      }

      if (!response.ok) {
        throw new RouteProviderError(
          `The routing provider returned status ${String(response.status)}.`,
        );
      }

      let payload: unknown;
      try {
        payload = await response.json();
      } catch (error: unknown) {
        throw new RouteProviderError('The routing provider returned invalid JSON.', {
          cause: error,
        });
      }

      const parsed = ValhallaResponseSchema.safeParse(payload);
      if (!parsed.success) {
        throw new RouteProviderError('The routing provider response failed validation.');
      }

      return normalizeRoutes(parsed.data);
    },
    ...(readinessEndpoint === undefined
      ? {}
      : {
          async isReady() {
            try {
              const response = await fetchImplementation(readinessEndpoint, {
                headers: { accept: 'application/json' },
                signal: AbortSignal.timeout(3_000),
              });
              return response.ok;
            } catch {
              return false;
            }
          },
        }),
    source: development
      ? {
          attribution: 'Routing by Valhalla using OpenStreetMap data',
          degraded: true,
          id: 'valhalla-development',
          mode: 'development',
          traffic: 'unavailable',
        }
      : {
          attribution: 'Routing by Valhalla using OpenStreetMap data',
          degraded: false,
          id: 'valhalla-self-hosted',
          mode: 'production',
          traffic: 'unavailable',
        },
  };
}
