import { z } from 'zod/v4';

import { GeographicBoundsSchema, IsoDateTimeSchema } from './common.js';

export const AppConfigResponseSchema = z
  .object({
    apiVersion: z.literal('v1'),
    coverage: z
      .object({
        id: z.literal('calgary-ab'),
        displayName: z.literal('Calgary, Alberta'),
        bounds: GeographicBoundsSchema,
        modes: z.array(z.literal('driving')).min(1),
      })
      .strict(),
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
    style: z
      .object({
        id: z.string().min(1),
        version: z.string().min(1),
      })
      .strict(),
    attribution: z.array(
      z
        .object({
          label: z.string().min(1),
          url: z.url(),
        })
        .strict(),
    ),
  })
  .strict();

export type AppConfigResponse = z.infer<typeof AppConfigResponseSchema>;
