import { createHash } from 'node:crypto';

import {
  compareRouteAlternatives,
  RoutePositionSchema,
  type RouteAlternative,
  type RouteRequest,
} from '@navoss/contracts';
import { z } from 'zod/v4';

const DEFAULT_VALHALLA_URL = 'https://valhalla1.openstreetmap.de/route';
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

export class RouteProviderError extends Error {
  public constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'RouteProviderError';
  }
}

export interface RouteProvider {
  getRoutes(request: RouteRequest): Promise<RouteAlternative[]>;
  isReady?(): Promise<boolean>;
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
          const spokenInstruction = step.voiceInstructions?.[0]?.announcement;
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

export function createValhallaRouteProvider(
  options: ValhallaRouteProviderOptions = {},
): RouteProvider {
  const endpoint = options.endpoint ?? process.env.VALHALLA_URL ?? DEFAULT_VALHALLA_URL;
  const fetchImplementation = options.fetchImplementation ?? fetch;
  const readinessEndpoint = options.readinessEndpoint ?? process.env.VALHALLA_STATUS_URL;

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
  };
}
