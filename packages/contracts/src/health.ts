import { z } from 'zod/v4';

import { IsoDateTimeSchema } from './common.js';

export const HealthResponseSchema = z
  .object({
    service: z.literal('navoss-api'),
    status: z.literal('ok'),
    timestamp: IsoDateTimeSchema,
    version: z.string().regex(/^\d+\.\d+\.\d+$/),
  })
  .strict();

export type HealthResponse = z.infer<typeof HealthResponseSchema>;

export const ReadinessCheckSchema = z
  .object({
    detail: z.string().min(1),
    status: z.enum(['ready', 'not_ready']),
  })
  .strict();

export const ReadinessResponseSchema = z
  .object({
    checks: z
      .object({
        searchFixtures: ReadinessCheckSchema,
      })
      .strict(),
    status: z.enum(['ready', 'not_ready']),
    timestamp: IsoDateTimeSchema,
  })
  .strict();

export type ReadinessResponse = z.infer<typeof ReadinessResponseSchema>;
