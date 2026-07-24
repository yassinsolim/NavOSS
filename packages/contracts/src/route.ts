import { z } from 'zod/v4';

import { CoordinateSchema, IsoDateTimeSchema, LatitudeSchema, LongitudeSchema } from './common.js';

export const RoutePreferencesSchema = z
  .object({
    avoidFerries: z.boolean().default(false),
    avoidHighways: z.boolean().default(false),
    avoidTolls: z.boolean().default(false),
    avoidUnpaved: z.boolean().default(false),
  })
  .strict();

export type RoutePreferences = z.output<typeof RoutePreferencesSchema>;

export const RouteRequestSchema = z
  .object({
    alternatives: z.number().int().min(0).max(2).default(1),
    destination: CoordinateSchema,
    origin: CoordinateSchema,
    preferences: RoutePreferencesSchema.default({
      avoidFerries: false,
      avoidHighways: false,
      avoidTolls: false,
      avoidUnpaved: false,
    }),
  })
  .strict()
  .superRefine((request, context) => {
    if (
      request.origin.latitude === request.destination.latitude &&
      request.origin.longitude === request.destination.longitude
    ) {
      context.addIssue({
        code: 'custom',
        message: 'origin and destination must be different',
        path: ['destination'],
      });
    }
  });

export type RouteRequest = z.output<typeof RouteRequestSchema>;

export const RoutePositionSchema = z.tuple([LongitudeSchema, LatitudeSchema]);

export const RouteStepSchema = z
  .object({
    distanceMeters: z.number().nonnegative(),
    durationSeconds: z.number().nonnegative(),
    geometry: z.array(RoutePositionSchema).min(2),
    instruction: z.string().min(1),
    maneuverType: z.string().min(1),
    roadName: z.string(),
    spokenInstruction: z.string().min(1).optional(),
  })
  .strict();

export type RouteStep = z.infer<typeof RouteStepSchema>;

export const RouteAlternativeSchema = z
  .object({
    distanceMeters: z.number().positive(),
    durationSeconds: z.number().positive(),
    geometry: z.array(RoutePositionSchema).min(2),
    id: z.string().min(1),
    label: z.enum(['fastest', 'alternative']),
    steps: z.array(RouteStepSchema).min(1),
    traffic: z
      .object({
        delaySeconds: z.number().nonnegative(),
        typicalDurationSeconds: z.number().positive(),
      })
      .strict()
      .optional(),
  })
  .strict();

export type RouteAlternative = z.infer<typeof RouteAlternativeSchema>;

export function compareRouteAlternatives(
  left: Pick<RouteAlternative, 'distanceMeters' | 'durationSeconds'>,
  right: Pick<RouteAlternative, 'distanceMeters' | 'durationSeconds'>,
): number {
  const durationDifference = left.durationSeconds - right.durationSeconds;
  return durationDifference === 0 ? left.distanceMeters - right.distanceMeters : durationDifference;
}

export const RouteResponseSchema = z
  .object({
    degraded: z.boolean(),
    generatedAt: IsoDateTimeSchema,
    routes: z.array(RouteAlternativeSchema).min(1).max(3),
    source: z
      .object({
        attribution: z.enum([
          'Routing by Valhalla using OpenStreetMap data',
          'Routing and traffic by Mapbox',
        ]),
        id: z.enum(['mapbox-traffic', 'valhalla-development', 'valhalla-self-hosted']),
        mode: z.enum(['development', 'production']),
        traffic: z.enum(['live', 'unavailable']),
      })
      .strict(),
  })
  .superRefine((response, context) => {
    const production = response.source.mode === 'production';
    const mapboxTraffic = response.source.id === 'mapbox-traffic';
    if (response.degraded === production) {
      context.addIssue({
        code: 'custom',
        message: 'production routes must not be degraded and development routes must be degraded',
        path: ['degraded'],
      });
    }
    if (production !== (response.source.id !== 'valhalla-development')) {
      context.addIssue({
        code: 'custom',
        message: 'route source id and mode must describe the same provider posture',
        path: ['source', 'id'],
      });
    }
    if (
      mapboxTraffic !== (response.source.traffic === 'live') ||
      mapboxTraffic !== (response.source.attribution === 'Routing and traffic by Mapbox')
    ) {
      context.addIssue({
        code: 'custom',
        message: 'route source traffic and attribution must describe the selected provider',
        path: ['source', 'traffic'],
      });
    }
    response.routes.forEach((route, index) => {
      if (mapboxTraffic !== (route.traffic !== undefined)) {
        context.addIssue({
          code: 'custom',
          message: 'live routes require traffic detail and unavailable routes must omit it',
          path: ['routes', index, 'traffic'],
        });
        return;
      }
      if (route.traffic !== undefined) {
        const expectedDelay = Math.max(
          0,
          route.durationSeconds - route.traffic.typicalDurationSeconds,
        );
        if (Math.abs(route.traffic.delaySeconds - expectedDelay) > 0.001) {
          context.addIssue({
            code: 'custom',
            message: 'traffic delay must equal total duration above typical duration',
            path: ['routes', index, 'traffic', 'delaySeconds'],
          });
        }
      }
    });
  })
  .strict();

export type RouteResponse = z.infer<typeof RouteResponseSchema>;
