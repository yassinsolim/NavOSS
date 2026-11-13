import { z } from 'zod/v4';

import { GeographicBoundsSchema, IsoDateTimeSchema } from './common.js';
import {
  CoverageBoundarySourceSchema,
  CoverageOverlaySchema,
  ServiceAreaSchema,
} from './coverage.js';
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
    endpoints: AppConfigBaseShape.endpoints.extend({ routes: z.literal('/v2/routes') }),
    coverage: z
      .object({
        boundarySource: CoverageBoundarySourceSchema,
        displayName: z.string().min(1),
        id: z.string().min(1),
        modes: z.array(z.literal('driving')).min(1),
        overlays: z.array(CoverageOverlaySchema),
        serviceAreas: z.array(ServiceAreaSchema).min(1),
      })
      .strict(),
  })
  .strict();

export type AppConfigResponse = z.infer<typeof AppConfigResponseSchema>;
export type LegacyAppConfigResponse = z.infer<typeof LegacyAppConfigResponseSchema>;
