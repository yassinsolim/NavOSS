import { z } from 'zod/v4';

export const LatitudeSchema = z.number().min(-90).max(90).describe('Latitude in degrees');

export const LongitudeSchema = z.number().min(-180).max(180).describe('Longitude in degrees');

export const CoordinateSchema = z
  .object({
    latitude: LatitudeSchema,
    longitude: LongitudeSchema,
  })
  .strict();

export type Coordinate = z.infer<typeof CoordinateSchema>;

export const GeographicBoundsSchema = z
  .object({
    northEast: CoordinateSchema,
    southWest: CoordinateSchema,
  })
  .strict()
  .superRefine((bounds, context) => {
    if (bounds.northEast.latitude <= bounds.southWest.latitude) {
      context.addIssue({
        code: 'custom',
        message: 'northEast latitude must be north of southWest latitude',
        path: ['northEast', 'latitude'],
      });
    }

    if (bounds.northEast.longitude <= bounds.southWest.longitude) {
      context.addIssue({
        code: 'custom',
        message: 'northEast longitude must be east of southWest longitude',
        path: ['northEast', 'longitude'],
      });
    }
  });

export type GeographicBounds = z.infer<typeof GeographicBoundsSchema>;

export const IsoDateTimeSchema = z.iso.datetime({ offset: true });
