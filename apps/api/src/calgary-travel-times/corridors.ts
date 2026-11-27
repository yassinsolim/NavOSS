import { z } from 'zod/v4';

import table from './corridors.json' with { type: 'json' };

export const CORRIDOR_TABLE_FORMAT = 'navoss-calgary-travel-times-corridors';

const AnchorSchema = z.strictObject({
  /** Direction of travel on the carriageway at this point, degrees clockwise from north. */
  headingDegrees: z.number().int().min(0).lt(360),
  latitude: z.number().min(49).max(52),
  longitude: z.number().min(-116).max(-113),
});
export type CorridorAnchor = z.infer<typeof AnchorSchema>;

const CorridorSchema = z.strictObject({
  /** Start, optional vias, end, each on the carriageway the corridor uses. */
  anchors: z.array(AnchorSchema).min(2).max(6),
  /**
   * Free-flow minutes from recorded quiet-hour values (`calgary-travel-times-baselines.mts`).
   * Null until recordings exist: such a corridor is placed but never applied.
   */
  baselineMinutes: z.number().int().positive().nullable(),
  expectedMeters: z.number().int().positive(),
  /** Street names or route refs as Valhalla reports them; a name matches itself or a suffixed form. */
  roads: z.array(z.string().min(1)).min(1),
  /** The exact `road_segment` label of the feed. */
  segment: z.string().min(1),
});
export type CorridorDefinition = z.infer<typeof CorridorSchema>;

export const CorridorTableSchema = z
  .strictObject({
    baselines: z.strictObject({
      method: z.string().min(1),
      recordedFrom: z.iso.datetime().nullable(),
      recordedTo: z.iso.datetime().nullable(),
      snapshots: z.number().int().nonnegative(),
    }),
    corridors: z.array(CorridorSchema).min(1),
    format: z.literal(CORRIDOR_TABLE_FORMAT),
    formatVersion: z.literal(1),
    leftOut: z.array(z.strictObject({ reason: z.string().min(1), segment: z.string().min(1) })),
  })
  .superRefine((value, context) => {
    const labels = [...value.corridors, ...value.leftOut].map((entry) => entry.segment);
    if (new Set(labels).size !== labels.length) {
      context.addIssue({ code: 'custom', message: 'every feed label appears once', path: [] });
    }
  });
export type CorridorTable = z.infer<typeof CorridorTableSchema>;

/** The checked-in corridor table, validated when the module loads. */
export const CORRIDOR_TABLE: CorridorTable = CorridorTableSchema.parse(table);
