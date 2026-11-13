import { z } from 'zod/v4';

import { IsoDateTimeSchema, LatitudeSchema, LongitudeSchema } from './common.js';

const Sha256Schema = z.string().regex(/^[0-9a-f]{64}$/);
const DataDateSchema = z.iso.date();
const PositionSchema = z.tuple([LongitudeSchema, LatitudeSchema]);
const RingSchema = z
  .array(PositionSchema)
  .min(4)
  .max(100_000)
  .superRefine((ring, context) => {
    const first = ring[0];
    const last = ring.at(-1);
    if (first?.[0] !== last?.[0] || first?.[1] !== last?.[1]) {
      context.addIssue({ code: 'custom', message: 'Polygon rings must be closed' });
    }
    let twiceArea = 0;
    for (let index = 1; index < ring.length; index += 1) {
      const previous = ring[index - 1];
      const current = ring[index];
      if (previous && current) {
        twiceArea += previous[0] * current[1] - current[0] * previous[1];
      }
    }
    if (Math.abs(twiceArea) < 1e-12) {
      context.addIssue({ code: 'custom', message: 'Polygon rings must enclose an area' });
    }
  });

export const OfflineBundlePolygonSchema = z
  .object({
    type: z.literal('MultiPolygon'),
    coordinates: z.array(z.array(RingSchema).min(1).max(100)).min(1).max(1000),
  })
  .strict();

const BoundsSchema = z
  .tuple([LongitudeSchema, LatitudeSchema, LongitudeSchema, LatitudeSchema])
  .refine(([west, south, east, north]) => west < east && south < north, {
    message: 'Bounds must be [west, south, east, north] with positive area',
  });

const ArtifactUrlSchema = z.url().superRefine((value, context) => {
  const url = new URL(value);
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (
    (url.protocol !== 'https:' && !(local && url.protocol === 'http:')) ||
    url.username ||
    url.password ||
    url.hash ||
    url.search
  ) {
    context.addIssue({
      code: 'custom',
      message: 'Artifacts require immutable HTTPS URLs (loopback HTTP is allowed for testing)',
    });
  }
});

const ArtifactFields = {
  url: ArtifactUrlSchema,
  byteSize: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  sha256: Sha256Schema,
};

const AttributionSchema = z
  .object({
    text: z.string().min(1).max(1000),
    url: z.url({ protocol: /^https?$/ }),
    license: z.string().min(1).max(100),
  })
  .strict();

export const OfflineBundleRegionSchema = z
  .object({
    id: z
      .string()
      .regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/)
      .max(64),
    name: z.string().min(1).max(120),
    polygon: OfflineBundlePolygonSchema,
    bounds: BoundsSchema,
    overlapMeters: z.number().int().min(0).max(100_000),
    dataDate: DataDateSchema,
    artifacts: z
      .object({
        maps: z
          .object({
            ...ArtifactFields,
            format: z.literal('pmtiles'),
            formatVersion: z.literal(3),
            schema: z.literal('openmaptiles'),
            schemaVersion: z.string().regex(/^\d+\.\d+(?:\.\d+)?$/),
            minZoom: z.number().int().min(0).max(16),
            maxZoom: z.number().int().min(0).max(16),
          })
          .strict()
          .refine((maps) => maps.minZoom <= maps.maxZoom, {
            message: 'Map zoom range is inverted',
          }),
        routing: z
          .object({
            ...ArtifactFields,
            format: z.literal('valhalla-tar'),
            formatVersion: z.literal(1),
            routingEngineVersion: z.literal('3.9.1'),
            tileFormat: z.literal('valhalla-gph'),
            tileFormatVersion: z.literal('3.9.1'),
            graphId: Sha256Schema,
          })
          .strict(),
        search: z
          .object({
            ...ArtifactFields,
            format: z.literal('sqlite-fts5'),
            formatVersion: z.literal(1),
            schemaVersion: z.literal(1),
          })
          .strict(),
        resources: z
          .object({
            ...ArtifactFields,
            format: z.literal('tar-gzip'),
            formatVersion: z.literal(1),
            schemaVersion: z.literal(1),
            unpackedByteSize: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
            styles: z.tuple([
              z.literal('liberty'),
              z.literal('bright'),
              z.literal('positron'),
              z.literal('dark'),
            ]),
          })
          .strict(),
      })
      .strict(),
    attribution: z.array(AttributionSchema).min(1).max(32),
  })
  .strict()
  .superRefine((region, context) => {
    const [west, south, east, north] = region.bounds;
    for (const polygon of region.polygon.coordinates) {
      for (const ring of polygon) {
        if (
          ring.some(
            ([longitude, latitude]) =>
              longitude < west - 1e-7 ||
              longitude > east + 1e-7 ||
              latitude < south - 1e-7 ||
              latitude > north + 1e-7,
          )
        ) {
          context.addIssue({
            code: 'custom',
            path: ['bounds'],
            message: 'Bounds must contain the advertised coverage polygon',
          });
        }
      }
    }
  });

/** Version 1 describes downloadable build artifacts, not installed app functionality. */
export const OfflineBundleManifestSchema = z
  .object({
    schemaVersion: z.literal(1),
    bundleVersion: z.string().regex(/^\d{4}-\d{2}-\d{2}-v1-[0-9a-f]{12}$/),
    dataDate: DataDateSchema,
    osmTimestamp: IsoDateTimeSchema,
    generatedAt: IsoDateTimeSchema,
    minimumAppContractVersion: z.number().int().positive(),
    graph: z
      .object({
        id: Sha256Schema,
        routingEngineVersion: z.literal('3.9.1'),
        tileFormat: z.literal('valhalla-gph'),
        tileFormatVersion: z.literal('3.9.1'),
        speedProfileSha256: Sha256Schema,
      })
      .strict(),
    regions: z.array(OfflineBundleRegionSchema).min(1).max(64),
  })
  .strict()
  .superRefine((manifest, context) => {
    const ids = new Set<string>();
    for (const [index, region] of manifest.regions.entries()) {
      if (ids.has(region.id)) {
        context.addIssue({
          code: 'custom',
          path: ['regions', index, 'id'],
          message: 'Region IDs must be unique',
        });
      }
      ids.add(region.id);
      if (region.dataDate !== manifest.dataDate) {
        context.addIssue({
          code: 'custom',
          path: ['regions', index, 'dataDate'],
          message: 'All regions must use the manifest data date',
        });
      }
      if (region.artifacts.routing.graphId !== manifest.graph.id) {
        context.addIssue({
          code: 'custom',
          path: ['regions', index, 'artifacts', 'routing', 'graphId'],
          message: 'All extracts must come from one connected graph',
        });
      }
    }
    if (manifest.osmTimestamp.slice(0, 10) !== manifest.dataDate) {
      context.addIssue({
        code: 'custom',
        path: ['osmTimestamp'],
        message: 'OSM timestamp must identify the data date',
      });
    }
    if (!manifest.bundleVersion.startsWith(`${manifest.dataDate}-v1-`)) {
      context.addIssue({
        code: 'custom',
        path: ['bundleVersion'],
        message: 'Bundle version must identify the data date',
      });
    }
  });

export type OfflineBundleManifest = z.infer<typeof OfflineBundleManifestSchema>;
export type OfflineBundleRegion = z.infer<typeof OfflineBundleRegionSchema>;
