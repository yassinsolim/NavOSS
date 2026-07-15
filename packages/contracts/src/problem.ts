import { z } from 'zod/v4';

export const ProblemCodeSchema = z.enum([
  'invalid_request',
  'not_found',
  'service_unavailable',
  'internal_error',
]);

export const ProblemDetailsSchema = z
  .object({
    code: ProblemCodeSchema,
    detail: z.string().min(1),
    requestId: z.string().min(1),
    status: z.number().int().min(400).max(599),
    title: z.string().min(1),
  })
  .strict();

export type ProblemCode = z.infer<typeof ProblemCodeSchema>;
export type ProblemDetails = z.infer<typeof ProblemDetailsSchema>;
