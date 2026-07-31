import { z } from 'zod/v4';

import { CoordinateSchema, IsoDateTimeSchema } from './common.js';

export const SafetyFacilityRegionSchema = z.literal('kelowna-bc');
export const SafetyFacilityQuerySchema = z.object({ region: SafetyFacilityRegionSchema }).strict();

const SafetyFacilityBaseShape = {
  kind: z.literal('facility'),
  pageUrl: z.literal('https://rcmp.ca/en/bc/kelowna/contact'),
  regionId: SafetyFacilityRegionSchema,
  type: z.literal('police-station'),
} as const;

const MainDetachmentSchema = z
  .object({
    ...SafetyFacilityBaseShape,
    address: z.literal('1190 Richter St'),
    coordinate: CoordinateSchema.extend({
      latitude: z.literal(49.89385756349143),
      longitude: z.literal(-119.48887718651372),
    }),
    id: z.literal('kelowna-rcmp:main-detachment'),
    name: z.literal('Main Detachment'),
    phone: z.literal('250-762-3300'),
  })
  .strict();

const RutlandCommunityPoliceOfficeSchema = z
  .object({
    ...SafetyFacilityBaseShape,
    address: z.literal('115 McIntosh Rd'),
    coordinate: CoordinateSchema.extend({
      latitude: z.literal(49.891982880689184),
      longitude: z.literal(-119.38777082090141),
    }),
    id: z.literal('kelowna-rcmp:rutland-community-police-office'),
    name: z.literal('Rutland Community Police Office'),
    phone: z.literal('250-765-6355'),
  })
  .strict();

export const SafetyFacilitySchema = z.union([
  MainDetachmentSchema,
  RutlandCommunityPoliceOfficeSchema,
]);

export const SafetyFacilityResponseSchema = z
  .object({
    facilities: z.array(SafetyFacilitySchema).length(2),
    generatedAt: IsoDateTimeSchema,
    source: z
      .object({
        attribution: z.literal('Royal Canadian Mounted Police'),
        dateModified: z.literal('2024-12-19'),
        regionId: SafetyFacilityRegionSchema,
        sourceId: z.literal('kelowna-rcmp-public-facilities'),
        sourceUrl: z.literal('https://rcmp.ca/en/bc/kelowna/contact'),
      })
      .strict(),
  })
  .strict()
  .superRefine((response, context) => {
    const ids = new Set(response.facilities.map((facility) => facility.id));
    if (
      ids.size !== 2 ||
      !ids.has('kelowna-rcmp:main-detachment') ||
      !ids.has('kelowna-rcmp:rutland-community-police-office')
    ) {
      context.addIssue({
        code: 'custom',
        message: 'the two approved Kelowna RCMP public facilities must be represented exactly once',
        path: ['facilities'],
      });
    }
  });

export type SafetyFacility = z.infer<typeof SafetyFacilitySchema>;
export type SafetyFacilityQuery = z.infer<typeof SafetyFacilityQuerySchema>;
export type SafetyFacilityRegion = z.infer<typeof SafetyFacilityRegionSchema>;
export type SafetyFacilityResponse = z.infer<typeof SafetyFacilityResponseSchema>;
