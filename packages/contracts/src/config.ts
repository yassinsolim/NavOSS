import { z } from 'zod/v4';

import { GeographicBoundsSchema, IsoDateTimeSchema } from './common.js';
const AppConfigBaseShape = {
  attribution: z.array(z.object({ label: z.string().min(1), url: z.url() }).strict()),
  endpoints: z
    .object({
      cameras: z.string().startsWith('/v1/'),
      events: z.string().startsWith('/v1/'),
      routes: z.string().startsWith('/v1/'),
      search: z.string().startsWith('/v1/'),
    })
    .strict(),
  features: z
    .object({
      communityReports: z.boolean(),
      liveTraffic: z.boolean(),
      officialSafetyCameras: z.boolean(),
      productionSearch: z.boolean(),
    })
    .strict(),
  generatedAt: IsoDateTimeSchema,
  minimumAppVersion: z.string().regex(/^\d+\.\d+\.\d+$/),
  style: z.object({ id: z.string().min(1), version: z.string().min(1) }).strict(),
} as const;

export const LegacyAppConfigResponseSchema = z
  .object({
    ...AppConfigBaseShape,
    apiVersion: z.literal('v1'),
    coverage: z
      .object({
        bounds: GeographicBoundsSchema,
        displayName: z.literal('Calgary, Alberta'),
        id: z.literal('calgary-ab'),
        modes: z.array(z.literal('driving')).min(1),
      })
      .strict(),
  })
  .strict();

export const AppConfigResponseSchema = z
  .object({
    ...AppConfigBaseShape,
    apiVersion: z.literal('v2'),
    coverage: z
      .object({
        displayName: z.literal('Calgary and Kelowna service areas'),
        id: z.literal('calgary-kelowna-service-areas'),
        modes: z.array(z.literal('driving')).min(1),
        serviceAreas: z.tuple([
          z
            .object({
              bounds: GeographicBoundsSchema,
              displayName: z.literal('Calgary, Alberta'),
              id: z.literal('calgary-ab'),
            })
            .strict(),
          z
            .object({
              bounds: GeographicBoundsSchema,
              displayName: z.literal('Kelowna, British Columbia'),
              id: z.literal('kelowna-bc'),
            })
            .strict(),
        ]),
      })
      .strict(),
  })
  .strict();

export type AppConfigResponse = z.infer<typeof AppConfigResponseSchema>;
export type LegacyAppConfigResponse = z.infer<typeof LegacyAppConfigResponseSchema>;
