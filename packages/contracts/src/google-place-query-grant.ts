import { z } from 'zod';

import { IsoDateTimeSchema } from './common.js';

export const GooglePlaceQueryGrantResponseSchema = z
  .object({
    granted: z.boolean(),
    limit: z.number().int().positive().max(8_000),
    period: z.string().regex(/^\d{4}-\d{2}$/),
    remaining: z.number().int().nonnegative(),
    resetsAt: IsoDateTimeSchema,
  })
  .superRefine((value, context) => {
    if (value.remaining > value.limit) {
      context.addIssue({
        code: 'custom',
        message: 'remaining must not exceed limit',
        path: ['remaining'],
      });
    }
  });

export type GooglePlaceQueryGrantResponse = z.infer<typeof GooglePlaceQueryGrantResponseSchema>;
