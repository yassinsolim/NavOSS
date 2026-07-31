import { z } from 'zod/v4';

import { CoordinateSchema, IsoDateTimeSchema } from './common.js';

export const TrafficCameraRegionSchema = z.literal('kelowna-bc');
const KELOWNA_BOUNDS = { east: -119.2, north: 50.15, south: 49.7, west: -119.65 } as const;
export const TrafficCameraQuerySchema = z.object({ region: TrafficCameraRegionSchema }).strict();

export const TrafficCameraSchema = z
  .object({
    cameraType: z.literal('traffic'),
    caption: z.string().trim().min(1).max(1_000),
    coordinate: CoordinateSchema,
    enforcement: z.literal(false),
    highway: z.string().trim().min(1).max(80),
    id: z.string().min(1).max(160),
    imageUrl: z.url(),
    name: z.string().trim().min(1).max(240),
    orientation: z.string().trim().min(1).max(80).optional(),
    pageUrl: z.url(),
    regionId: TrafficCameraRegionSchema,
    thumbnailUrl: z.url(),
  })
  .strict()
  .superRefine((camera, context) => {
    if (
      camera.coordinate.latitude < KELOWNA_BOUNDS.south ||
      camera.coordinate.latitude > KELOWNA_BOUNDS.north ||
      camera.coordinate.longitude < KELOWNA_BOUNDS.west ||
      camera.coordinate.longitude > KELOWNA_BOUNDS.east
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Kelowna traffic cameras must remain within regional bounds',
        path: ['coordinate'],
      });
    }
  });

export const TrafficCameraSourceSchema = z
  .object({
    attribution: z.literal(
      'Contains information licensed under the Open Government Licence \u2013 British Columbia.',
    ),
    catalogueUrl: z.literal(
      'https://catalogue.data.gov.bc.ca/dataset/6b39a910-6c77-476f-ac96-7b4f18849b1c',
    ),
    datasetId: z.literal('6b39a910-6c77-476f-ac96-7b4f18849b1c'),
    dataUrl: z.literal(
      'https://catalogue.data.gov.bc.ca/dataset/6b39a910-6c77-476f-ac96-7b4f18849b1c/resource/a9d52d85-8402-4ce7-b2ac-a2779837c48a/download/webcams.csv',
    ),
    licenseUrl: z.literal('https://www2.gov.bc.ca/gov/content?id=A519A56BC2BF44E4A008B33FCF527F61'),
    regionId: TrafficCameraRegionSchema,
    resourceId: z.literal('a9d52d85-8402-4ce7-b2ac-a2779837c48a'),
    sourceId: z.literal('drivebc-highwaycams'),
    updateFrequency: z.literal('monthly'),
    updatedAt: IsoDateTimeSchema.optional(),
  })
  .strict();

export const TrafficCameraResponseSchema = z
  .object({
    cameras: z.array(TrafficCameraSchema).max(1_000),
    degraded: z.boolean(),
    generatedAt: IsoDateTimeSchema,
    source: TrafficCameraSourceSchema,
    stale: z.boolean(),
  })
  .strict()
  .superRefine((response, context) => {
    if (response.degraded !== response.stale) {
      context.addIssue({
        code: 'custom',
        message: 'traffic cameras are degraded exactly when the last valid snapshot is stale',
        path: ['degraded'],
      });
    }
  });

export type TrafficCamera = z.infer<typeof TrafficCameraSchema>;
export type TrafficCameraQuery = z.infer<typeof TrafficCameraQuerySchema>;
export type TrafficCameraRegion = z.infer<typeof TrafficCameraRegionSchema>;
export type TrafficCameraResponse = z.infer<typeof TrafficCameraResponseSchema>;
export type TrafficCameraSource = z.infer<typeof TrafficCameraSourceSchema>;
