import { z } from 'zod/v4';

import { IsoDateTimeSchema } from './common.js';

export const ContributionTypeSchema = z.enum([
  'missing-place',
  'place-correction',
  'route-issue',
  'road-change',
]);

export const ContributionSubmissionRequestSchema = z
  .object({
    createdAt: IsoDateTimeSchema,
    description: z.string().trim().min(3).max(800),
    draftId: z.string().trim().min(1).max(100),
    locationLabel: z.string().trim().min(1).max(160).optional(),
    type: ContributionTypeSchema,
  })
  .strict();

export const ContributionSubmissionResponseSchema = z
  .object({
    acceptedAt: IsoDateTimeSchema,
    status: z.literal('accepted'),
    submissionId: z.uuid(),
  })
  .strict();

export type ContributionSubmissionRequest = z.infer<typeof ContributionSubmissionRequestSchema>;
export type ContributionSubmissionResponse = z.infer<typeof ContributionSubmissionResponseSchema>;
export type ContributionType = z.infer<typeof ContributionTypeSchema>;
