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
        attribution: z.literal('Routing by Valhalla using OpenStreetMap data'),
        id: z.enum(['valhalla-development', 'valhalla-self-hosted']),
        mode: z.enum(['development', 'production']),
        traffic: z.literal('unavailable'),
      })
      .strict(),
  })
  .superRefine((response, context) => {
    const production = response.source.mode === 'production';
    if (response.degraded === production) {
      context.addIssue({
        code: 'custom',
        message: 'production routes must not be degraded and development routes must be degraded',
        path: ['degraded'],
      });
    }
    if (production !== (response.source.id === 'valhalla-self-hosted')) {
      context.addIssue({
        code: 'custom',
        message: 'route source id and mode must describe the same provider posture',
        path: ['source', 'id'],
      });
    }
  })
  .strict();

export type RouteResponse = z.infer<typeof RouteResponseSchema>;
