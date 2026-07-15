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

export const RouteResponseSchema = z
  .object({
    degraded: z.literal(true),
    generatedAt: IsoDateTimeSchema,
    routes: z.array(RouteAlternativeSchema).min(1).max(3),
    source: z
      .object({
        attribution: z.literal('Routing by Valhalla using OpenStreetMap data'),
        id: z.literal('valhalla-development'),
        mode: z.literal('development'),
        traffic: z.literal('unavailable'),
      })
      .strict(),
  })
  .strict();

export type RouteResponse = z.infer<typeof RouteResponseSchema>;
