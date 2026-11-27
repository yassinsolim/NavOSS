import { z } from 'zod/v4';

import {
  CommunityTrafficSourceSchema,
  RouteAlternativeV2Schema,
  RouteResponseSchema,
} from '../src/index.js';

/**
 * `RouteResponseV2Schema` exactly as `origin/main` defined it at 07a82b0, the contract shipped
 * builds 80-87 decode. Frozen on purpose: a response for a client that declared no extra traffic
 * source must still satisfy it, whatever the live schema later accepts.
 */
export const FrozenRouteResponseV2Schema = z
  .object({
    ...RouteResponseSchema.shape,
    routes: z.array(RouteAlternativeV2Schema).min(1).max(3),
    source: RouteResponseSchema.shape.source.extend({
      trafficSource: CommunityTrafficSourceSchema.optional(),
    }),
  })
  .strict()
  .superRefine((response, context) => {
    const production = response.source.mode === 'production';
    const mapboxTraffic = response.source.id === 'mapbox-traffic';
    const communityTraffic = response.source.trafficSource !== undefined;
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
      (mapboxTraffic || communityTraffic) !== (response.source.traffic === 'live') ||
      mapboxTraffic !== (response.source.attribution === 'Routing and traffic by Mapbox') ||
      (communityTraffic && mapboxTraffic)
    ) {
      context.addIssue({
        code: 'custom',
        message: 'route source traffic and attribution must describe the selected provider',
        path: ['source', 'traffic'],
      });
    }
    response.routes.forEach((route, index) => {
      if (
        (!mapboxTraffic && !communityTraffic && route.traffic !== undefined) ||
        (mapboxTraffic && route.traffic === undefined)
      ) {
        context.addIssue({
          code: 'custom',
          message: 'route traffic must describe the selected source',
          path: ['routes', index, 'traffic'],
        });
      }
      if (
        (route.congestion !== undefined || route.traffic?.observedFraction !== undefined) &&
        !communityTraffic
      ) {
        context.addIssue({
          code: 'custom',
          message: 'community route annotations require their traffic source',
          path: ['source', 'trafficSource'],
        });
      }
      if (
        communityTraffic &&
        route.traffic !== undefined &&
        (route.congestion === undefined || route.traffic.observedFraction === undefined)
      ) {
        context.addIssue({
          code: 'custom',
          message: 'community traffic detail requires congestion and observed fraction',
          path: ['routes', index, 'traffic'],
        });
      }
      const snapshotAt = route.traffic?.snapshotAt;
      const oldestObservedAt = route.traffic?.oldestObservedAt;
      if (
        (snapshotAt !== undefined || oldestObservedAt !== undefined) &&
        (route.traffic?.observedFraction === undefined ||
          snapshotAt === undefined ||
          oldestObservedAt === undefined ||
          Date.parse(oldestObservedAt) > Date.parse(snapshotAt))
      ) {
        context.addIssue({
          code: 'custom',
          message:
            'community traffic freshness needs both boundaries, the oldest no later than the snapshot',
          path: ['routes', index, 'traffic', 'snapshotAt'],
        });
      }
      if (route.traffic === undefined && route.congestion !== undefined) {
        context.addIssue({
          code: 'custom',
          message: 'a route without traffic must not publish congestion',
          path: ['routes', index, 'congestion'],
        });
      }
      if (
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
