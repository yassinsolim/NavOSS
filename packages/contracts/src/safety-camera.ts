import { z } from 'zod/v4';

import { CoordinateSchema, IsoDateTimeSchema } from './common.js';

export const SafetyCameraDirectionSchema = z.enum([
  'eastbound',
  'northbound',
  'southbound',
  'westbound',
]);

export const SafetyCameraSchema = z
  .object({
    community: z.string().min(1),
    coordinate: CoordinateSchema,
    direction: SafetyCameraDirectionSchema,
    enforcement: z.tuple([z.literal('red-light'), z.literal('speed-on-green')]),
    id: z.string().startsWith('calgary-isc:'),
    location: z.string().min(1),
    quadrant: z.enum(['NE', 'NW', 'SE', 'SW']),
    ward: z.number().int().min(1).max(14).optional(),
  })
  .strict();

export const SafetyCameraResponseSchema = z
  .object({
    cameras: z.array(SafetyCameraSchema).max(500),
    source: z
      .object({
        attribution: z.literal('The City of Calgary'),
        datasetId: z.literal('dv2f-necx'),
        datasetUrl: z.literal(
          'https://data.calgary.ca/Health-and-Safety/Intersection-Safety-Cameras/dv2f-necx',
        ),
        updateFrequency: z.literal('monthly'),
        updatedAt: IsoDateTimeSchema,
      })
      .strict(),
  })
  .strict();

export type SafetyCamera = z.infer<typeof SafetyCameraSchema>;
export type SafetyCameraDirection = z.infer<typeof SafetyCameraDirectionSchema>;
export type SafetyCameraResponse = z.infer<typeof SafetyCameraResponseSchema>;
