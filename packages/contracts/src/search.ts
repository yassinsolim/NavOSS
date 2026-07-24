import { z } from 'zod/v4';

import { CoordinateSchema, IsoDateTimeSchema, LatitudeSchema, LongitudeSchema } from './common.js';

export const SearchQuerySchema = z
  .object({
    includeDetails: z.boolean().optional(),
    latitude: z.coerce.number().pipe(LatitudeSchema).optional(),
    limit: z.coerce.number().int().min(1).max(20).default(8),
    longitude: z.coerce.number().pipe(LongitudeSchema).optional(),
    q: z.string().trim().min(2).max(120),
  })
  .strict()
  .superRefine((query, context) => {
    if ((query.latitude === undefined) !== (query.longitude === undefined)) {
      context.addIssue({
        code: 'custom',
        message: 'latitude and longitude must be provided together',
        path: query.latitude === undefined ? ['latitude'] : ['longitude'],
      });
    }
  });

export type SearchQuery = z.output<typeof SearchQuerySchema>;

export const PlaceDetailsSchema = z
  .object({
    address: z.string().trim().min(1).optional(),
    category: z.string().trim().min(1).optional(),
    openingHours: z.string().trim().min(1).optional(),
    phone: z.string().trim().min(1).optional(),
    website: z.string().trim().min(1).optional(),
    wheelchair: z.string().trim().min(1).optional(),
  })
  .strict();

export type PlaceDetails = z.infer<typeof PlaceDetailsSchema>;

export const SearchResultSchema = z
  .object({
    category: z.enum(['address', 'landmark', 'neighborhood', 'poi', 'street']),
    center: CoordinateSchema,
    confidence: z.number().min(0).max(1),
    distanceMeters: z.number().nonnegative().optional(),
    details: PlaceDetailsSchema.optional(),
    id: z.string().min(1),
    label: z.string().min(1),
    name: z.string().min(1),
  })
  .strict();

export type SearchResult = z.infer<typeof SearchResultSchema>;

export const SourceFreshnessSchema = z.enum(['fresh', 'stale', 'static']);

export const SearchSourceSchema = z
  .object({
    datasetVersion: z.string().min(1),
    freshness: SourceFreshnessSchema,
    id: z.string().min(1),
    updatedAt: IsoDateTimeSchema,
  })
  .strict();

export const SearchResponseSchema = z
  .object({
    degraded: z.boolean(),
    results: z.array(SearchResultSchema),
    source: SearchSourceSchema,
  })
  .strict();

export type SearchSource = z.infer<typeof SearchSourceSchema>;
export type SearchResponse = z.infer<typeof SearchResponseSchema>;
