import {
  parseTrafficFlowBounds,
  ProblemDetailsSchema,
  TrafficFlowQuerySchema,
  TrafficFlowResponseSchema,
  TrafficProbeBatchRequestSchema,
  TrafficProbeBatchResponseSchema,
  TrafficStatusResponseSchema,
} from '@navoss/contracts';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';

import type { ContributionRateLimiter } from '../contribution-rate-limiter.js';
import { createProblem } from '../problem.js';
import type { TrafficService } from './service.js';

const PROBE_BODY_LIMIT_BYTES = 32 * 1_024;
const SUMMARY_INTERVAL_MS = 15 * 60 * 1_000;

export function registerTrafficRoutes(
  app: FastifyInstance,
  service: TrafficService,
  rateLimiter: ContributionRateLimiter,
): void {
  const typedApp = app.withTypeProvider<ZodTypeProvider>();

  if (service.mode !== 'off') {
    // The operator's only view of the pipeline: counters and segment counts, nothing locatable.
    const summary = setInterval(() => {
      void service
        .coverage()
        .then((coverage) => {
          app.log.info({ coverage, counters: service.metrics() }, 'Community traffic summary');
        })
        .catch(() => undefined);
    }, SUMMARY_INTERVAL_MS);
    summary.unref();
    app.addHook('onClose', () => {
      clearInterval(summary);
    });
  }

  typedApp.post(
    '/v1/traffic/probes',
    {
      bodyLimit: PROBE_BODY_LIMIT_BYTES,
      schema: {
        body: TrafficProbeBatchRequestSchema,
        description:
          'Accepts one short batch of driving positions from a driver who switched traffic sharing on. The batch carries no account, device, installation or trip identifier. It is map-matched in memory, reduced to per-road-segment speed samples, and discarded; positions are never stored or logged.',
        response: {
          202: TrafficProbeBatchResponseSchema,
          400: ProblemDetailsSchema,
          429: ProblemDetailsSchema,
          503: ProblemDetailsSchema,
        },
        tags: ['traffic'],
      },
    },
    async (request, reply) => {
      if (service.mode !== 'off' && !rateLimiter.consume(request.ip)) {
        reply.status(429).header('retry-after', '600').type('application/problem+json');
        return createProblem(
          request,
          429,
          'rate_limited',
          'Traffic sharing rate limited',
          'Too many traffic batches were received. Discard this batch and pause uploads.',
        );
      }
      const outcome = await service.ingest(request.body, request.ip);
      if (outcome.status === 'rejected') {
        reply.status(400).type('application/problem+json');
        return createProblem(
          request,
          400,
          'invalid_request',
          'Traffic batch rejected',
          {
            future: 'The batch is dated in the future. Check the device clock.',
            implausible_speed: 'The batch contains a jump no road vehicle could make.',
            outside_coverage: 'The batch is outside the community-traffic coverage area.',
            stale: 'The batch is too old to describe current traffic.',
          }[outcome.reason],
        );
      }
      if (outcome.status === 'unavailable') {
        reply.status(503).header('retry-after', '300').type('application/problem+json');
        return createProblem(
          request,
          503,
          'service_unavailable',
          'Traffic sharing unavailable',
          'Community traffic is not accepting batches right now. Discard this batch; do not retry it.',
        );
      }
      reply.status(202);
      return { status: 'accepted' as const };
    },
  );

  typedApp.get(
    '/v1/traffic/flow',
    {
      schema: {
        description:
          'Returns current community traffic flow inside a grid-aligned box as a GeoJSON FeatureCollection for a map line layer. Only road segments observed by the minimum number of independent contributors are included.',
        querystring: TrafficFlowQuerySchema,
        response: {
          200: TrafficFlowResponseSchema,
          400: ProblemDetailsSchema,
          503: ProblemDetailsSchema,
        },
        tags: ['traffic'],
      },
    },
    async (request, reply) => {
      const bounds = parseTrafficFlowBounds(request.query.bbox);
      if (bounds === undefined) {
        reply.status(400).type('application/problem+json');
        return createProblem(
          request,
          400,
          'invalid_request',
          'Invalid traffic bounds',
          'bbox must be west,south,east,north on a 0.05-degree grid and span at most 2 degrees.',
        );
      }
      if (service.mode !== 'live') {
        reply.status(503).type('application/problem+json');
        return createProblem(
          request,
          503,
          'service_unavailable',
          'Live traffic unavailable',
          'Community traffic is not being published.',
        );
      }
      try {
        const flow = await service.flow(bounds);
        reply.header('cache-control', 'public, max-age=30');
        return flow;
      } catch {
        reply.status(503).type('application/problem+json');
        return createProblem(
          request,
          503,
          'service_unavailable',
          'Live traffic unavailable',
          'Community traffic could not be read right now.',
        );
      }
    },
  );

  typedApp.get(
    '/v1/traffic/status',
    {
      schema: {
        description:
          'Reports whether community traffic is off, collecting, or live, the upload rules the app must follow, the publication threshold, and service-wide counts of how much data backs the layer.',
        response: { 200: TrafficStatusResponseSchema, 503: ProblemDetailsSchema },
        tags: ['traffic'],
      },
    },
    async (request, reply) => {
      try {
        const status = await service.status();
        reply.header('cache-control', 'public, max-age=60');
        return status;
      } catch {
        reply.status(503).type('application/problem+json');
        return createProblem(
          request,
          503,
          'service_unavailable',
          'Traffic status unavailable',
          'Community traffic status could not be read right now.',
        );
      }
    },
  );
}
