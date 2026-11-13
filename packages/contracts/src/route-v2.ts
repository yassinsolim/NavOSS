import { z } from 'zod/v4';

import { CoordinateSchema } from './common.js';
import {
  RouteAlternativeSchema,
  RouteRequestSchema,
  RouteResponseSchema,
  RouteStepSchema,
} from './route.js';

export const RouteWaypointV2Schema = CoordinateSchema.extend({
  type: z.enum(['break', 'through']).default('break'),
});
export type RouteWaypointV2 = z.input<typeof RouteWaypointV2Schema>;

export const RouteRequestV2Schema = RouteRequestSchema.safeExtend({
  waypoints: z.array(RouteWaypointV2Schema).max(8).optional(),
});
// Public callers may omit the waypoint type; the API parser supplies its break default.
export type RouteRequestV2 = Omit<z.output<typeof RouteRequestV2Schema>, 'waypoints'> & {
  waypoints?: RouteWaypointV2[] | undefined;
};

export const RouteLaneIndicationSchema = z.enum([
  'none',
  'uturn',
  'sharp_left',
  'left',
  'slight_left',
  'straight',
  'slight_right',
  'right',
  'sharp_right',
  'merge_left',
  'merge_right',
]);
export type RouteLaneIndication = z.infer<typeof RouteLaneIndicationSchema>;

export const RouteLaneSchema = z
  .object({
    active: z.boolean().optional(),
    indications: z.array(RouteLaneIndicationSchema),
    valid: z.boolean(),
    validIndication: RouteLaneIndicationSchema.optional(),
  })
  .strict()
  .superRefine((lane, context) => {
    if (lane.active === true && !lane.valid) {
      context.addIssue({
        code: 'custom',
        message: 'an active lane must be valid',
        path: ['active'],
      });
    }
    if (
      lane.validIndication !== undefined &&
      (!lane.valid || !lane.indications.includes(lane.validIndication))
    ) {
      context.addIssue({
        code: 'custom',
        message: 'valid indication must belong to a valid lane',
        path: ['validIndication'],
      });
    }
  });
export type RouteLane = z.infer<typeof RouteLaneSchema>;

export const RouteSpeedLimitSchema = z.discriminatedUnion('status', [
  z.object({ kph: z.number().int().positive().max(250), status: z.literal('known') }).strict(),
  z.object({ status: z.literal('unknown') }).strict(),
  z.object({ status: z.literal('unlimited') }).strict(),
]);
export type RouteSpeedLimit = z.infer<typeof RouteSpeedLimitSchema>;

export const RouteStepV2Schema = RouteStepSchema.extend({
  bearingAfterDegrees: z.number().min(0).lt(360).optional(),
  bearingBeforeDegrees: z.number().min(0).lt(360).optional(),
  currentRoadName: z
    .string()
    .min(1)
    .optional()
    .describe('Road driven along this step geometry, not the following step'),
  exitNumber: z.string().min(1).optional(),
  junctionName: z.string().min(1).optional(),
  lanes: z
    .array(RouteLaneSchema)
    .min(1)
    .optional()
    .describe(
      'Left-to-right approach lanes for the maneuver at the beginning of this step; count is lanes.length',
    ),
  maneuverModifier: z
    .enum([
      'uturn',
      'sharp right',
      'right',
      'slight right',
      'straight',
      'slight left',
      'left',
      'sharp left',
    ])
    .optional(),
  roundaboutExit: z.number().int().positive().optional(),
  signpost: z.string().min(1).optional(),
  signpostBranch: z.array(z.string().min(1)).min(1).optional(),
  signpostToward: z.array(z.string().min(1)).min(1).optional(),
});
export type RouteStepV2 = z.infer<typeof RouteStepV2Schema>;

export const RouteAlternativeV2Schema = RouteAlternativeSchema.safeExtend({
  speedLimits: z
    .array(RouteSpeedLimitSchema)
    .min(1)
    .optional()
    .describe('Geometry-segment-aligned posted limits; unknown and unlimited are distinct'),
  steps: z.array(RouteStepV2Schema).min(1),
}).superRefine((route, context) => {
  if (route.speedLimits !== undefined && route.speedLimits.length !== route.geometry.length - 1) {
    context.addIssue({
      code: 'custom',
      message: 'speed limits must align with route geometry segments',
      path: ['speedLimits'],
    });
  }
});
export type RouteAlternativeV2 = z.infer<typeof RouteAlternativeV2Schema>;

// Reuse legacy field shapes, not the legacy response's traffic-only refinement. This is the
// versioned seam for future per-segment congestion/source detail without changing build 70.
export const RouteResponseV2Schema = z
  .object({
    ...RouteResponseSchema.shape,
    routes: z.array(RouteAlternativeV2Schema).min(1).max(3),
  })
  .strict()
  .superRefine((response, context) => {
    const production = response.source.mode === 'production';
    const mapboxTraffic = response.source.id === 'mapbox-traffic';
    if (response.degraded === production) {
      context.addIssue({
        code: 'custom',
        message: 'production routes must not be degraded and development routes must be degraded',
        path: ['degraded'],
      });
    }
    if (production !== (response.source.id !== 'valhalla-development')) {
      context.addIssue({
        code: 'custom',
        message: 'route source id and mode must describe the same provider posture',
        path: ['source', 'id'],
      });
    }
    if (
      mapboxTraffic !== (response.source.traffic === 'live') ||
      mapboxTraffic !== (response.source.attribution === 'Routing and traffic by Mapbox')
    ) {
      context.addIssue({
        code: 'custom',
        message: 'route source traffic and attribution must describe the selected provider',
        path: ['source', 'traffic'],
      });
    }
    response.routes.forEach((route, index) => {
      if (mapboxTraffic !== (route.traffic !== undefined)) {
        context.addIssue({
          code: 'custom',
          message: 'live routes require traffic detail and unavailable routes must omit it',
          path: ['routes', index, 'traffic'],
        });
      } else if (
        route.traffic !== undefined &&
        Math.abs(
          route.traffic.delaySeconds -
            Math.max(0, route.durationSeconds - route.traffic.typicalDurationSeconds),
        ) > 0.001
      ) {
        context.addIssue({
          code: 'custom',
          message: 'traffic delay must equal total duration above typical duration',
          path: ['routes', index, 'traffic', 'delaySeconds'],
        });
      }
    });
  });
export type RouteResponseV2 = z.infer<typeof RouteResponseV2Schema>;
