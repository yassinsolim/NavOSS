import { z } from 'zod/v4';

import { CoordinateSchema, IsoDateTimeSchema } from './common.js';
import { SafetyCameraDirectionSchema } from './safety-camera.js';

export const OfficialSafetyCameraEnforcementSchema = z.enum(['red-light', 'speed-on-green']);

export const OfficialSafetyCameraRegionSchema = z.enum(['toronto-on']);

export const OfficialSafetyCameraQuerySchema = z
  .object({
    region: OfficialSafetyCameraRegionSchema,
  })
  .strict();

export const OfficialSafetyCameraSchema = z
  .object({
    coordinate: CoordinateSchema,
    direction: SafetyCameraDirectionSchema.optional(),
    enforcement: z.array(OfficialSafetyCameraEnforcementSchema).min(1).max(2),
    id: z.string().min(1),
    jurisdiction: z.string().min(1),
    location: z.string().min(1),
    regionId: OfficialSafetyCameraRegionSchema,
  })
  .strict();

export const OfficialSafetyCameraResponseSchema = z
  .object({
    cameras: z.array(OfficialSafetyCameraSchema).max(1_000),
    generatedAt: IsoDateTimeSchema,
    source: z
      .object({
        attribution: z.string().min(1),
        datasetId: z.string().min(1),
        datasetUrl: z.url(),
        licenseUrl: z.url(),
        regionId: OfficialSafetyCameraRegionSchema,
        updateFrequency: z.enum(['daily', 'monthly']),
        updatedAt: IsoDateTimeSchema,
      })
      .strict(),
  })
  .strict();

export type OfficialSafetyCamera = z.infer<typeof OfficialSafetyCameraSchema>;
export type OfficialSafetyCameraQuery = z.infer<typeof OfficialSafetyCameraQuerySchema>;
export type OfficialSafetyCameraRegion = z.infer<typeof OfficialSafetyCameraRegionSchema>;
export type OfficialSafetyCameraResponse = z.infer<typeof OfficialSafetyCameraResponseSchema>;
