import {
  parseTrafficFlowBounds,
  ProblemDetailsSchema,
  TrafficCredentialRequestSchema,
  TrafficCredentialResponseSchema,
  TrafficFlowQuerySchema,
  TrafficFlowResponseSchema,
  TrafficProbeBatchRequestSchema,
  TrafficProbeBatchResponseSchema,
  TrafficStatusResponseSchema,
  type ProblemDetails,
} from '@navoss/contracts';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';

import { CommunityReportError, type CommunityReportFailure } from '../community-reports.js';
import { COMMUNITY_REPORT_FAILURES } from '../community-routes.js';
import { networkBucket } from '../community-trust.js';
import { createContributionRateLimiter } from '../contribution-rate-limiter.js';
import { createProblem } from '../problem.js';
import { InstallationTooNewError, type TrafficService } from './service.js';

const PROBE_BODY_LIMIT_BYTES = 32 * 1_024;
const SUMMARY_INTERVAL_MS = 15 * 60 * 1_000;
// An installation needs one credential every two hours; a network may hold many installations.
const CREDENTIALS_PER_NETWORK = 120;

function attestationProblem(
  request: FastifyRequest,
  reply: FastifyReply,
  reason: CommunityReportFailure,
): ProblemDetails {
  const failure = COMMUNITY_REPORT_FAILURES[reason];
  reply.status(failure.status).type('application/problem+json');
  if (failure.status === 429) reply.header('retry-after', '600');
  return createProblem(request, failure.status, failure.code, failure.title, failure.detail);
}

export function registerTrafficRoutes(
  app: FastifyInstance,
  service: TrafficService,
  options: { clock: () => Date },
): void {
  const typedApp = app.withTypeProvider<ZodTypeProvider>();
  const { settings } = service;
  const limiterOptions = {
    clock: () => options.clock().getTime(),
    globalLimit: Number.MAX_SAFE_INTEGER,
    windowMs: settings.rateLimitWindowSeconds * 1_000,
  };
  // Both limiters key on the same network bucket as community reports (IPv4 /24, IPv6 /48), so
  // rotating addresses inside one allocation does not buy a fresh quota. They only stop a flood
  // from one network; the per-installation limit is applied by the service after the credential
  // has been verified.
  const probeLimiter = createContributionRateLimiter({
    ...limiterOptions,
    sourceLimit: settings.rateLimitPerNetwork,
  });
  const credentialLimiter = createContributionRateLimiter({
    ...limiterOptions,
    sourceLimit: CREDENTIALS_PER_NETWORK,
  });
  app.addHook('onClose', () => {
    probeLimiter.close();
    credentialLimiter.close();
  });

  if (service.mode !== 'off') {
    // The operator's only view of the pipeline: counters, nothing locatable, never over HTTP.
    const summary = setInterval(() => {
      app.log.info({ counters: service.metrics() }, 'Community traffic summary');
    }, SUMMARY_INTERVAL_MS);
    summary.unref();
    app.addHook('onClose', () => {
      clearInterval(summary);
    });
  }

  typedApp.post(
    '/v2/traffic/credentials',
    {
      schema: {
        body: TrafficCredentialRequestSchema,
        description:
          'Exchanges one fresh App Attest assertion (operation `traffic-credential`) from a registered installation for a short-lived, opaque upload credential. The server keeps no record linking the credential, or anything uploaded with it, to the installation.',
        response: {
          200: TrafficCredentialResponseSchema,
          400: ProblemDetailsSchema,
          401: ProblemDetailsSchema,
          403: ProblemDetailsSchema,
          429: ProblemDetailsSchema,
          503: ProblemDetailsSchema,
        },
        tags: ['traffic'],
      },
    },
    async (request, reply) => {
      if (!credentialLimiter.consume(networkBucket(request.ip))) {
        return attestationProblem(request, reply, 'rate-limited');
      }
      try {
        const issued = await service.issueCredential(request.body.assertion);
        if (issued === undefined) {
          reply.status(503).type('application/problem+json');
          return createProblem(
            request,
            503,
            'service_unavailable',
            'Traffic sharing unavailable',
            'Community traffic is not issuing upload credentials.',
          );
        }
        return issued;
      } catch (error: unknown) {
        if (error instanceof InstallationTooNewError) {
          reply
            .status(403)
            .header('retry-after', String(error.retryAfterSeconds))
            .type('application/problem+json');
          return createProblem(
            request,
            403,
            'forbidden',
            'Installation too new',
            'This installation registered too recently to contribute traffic. Do not upload; ask again after the retry-after interval.',
          );
        }
        if (!(error instanceof CommunityReportError)) throw error;
        if (error.reason === 'unavailable') {
          request.log.error(
            {
              errorName: error.cause instanceof Error ? error.cause.name : 'Unavailable',
              requestId: request.id,
            },
            'Community traffic credentials unavailable',
          );
        }
        return attestationProblem(request, reply, error.reason);
      }
    },
  );

  typedApp.post(
    '/v2/traffic/probes',
    {
      bodyLimit: PROBE_BODY_LIMIT_BYTES,
      schema: {
        body: TrafficProbeBatchRequestSchema,
        description:
          'Accepts one short batch of driving positions from a driver who switched traffic sharing on, with the upload credential of an attested installation. The batch carries no account, installation or trip identifier. It is map-matched in memory, reduced to per-road-edge speed samples held in memory, and discarded; positions are never stored or logged by the API.',
        response: {
          202: TrafficProbeBatchResponseSchema,
          400: ProblemDetailsSchema,
          401: ProblemDetailsSchema,
          429: ProblemDetailsSchema,
          503: ProblemDetailsSchema,
        },
        tags: ['traffic'],
      },
    },
    async (request, reply) => {
      const rateLimited = () => {
        reply.status(429).header('retry-after', '600').type('application/problem+json');
        return createProblem(
          request,
          429,
          'rate_limited',
          'Traffic sharing rate limited',
          'Too many traffic batches were received. Discard this batch and pause uploads.',
        );
      };
      if (service.mode !== 'off' && !probeLimiter.consume(networkBucket(request.ip))) {
        return rateLimited();
      }
      const outcome = await service.ingest(request.body, { network: networkBucket(request.ip) });
      if (outcome.status === 'rate_limited') return rateLimited();
      if (outcome.status === 'unauthorized') {
        reply.status(401).type('application/problem+json');
        return createProblem(
          request,
          401,
          'unauthorized',
          'Upload credential rejected',
          'The upload credential is invalid or expired. Discard this batch and request a new credential.',
        );
      }
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
    '/v2/traffic/flow',
    {
      schema: {
        description:
          'Returns the community traffic snapshot of the current publication epoch inside a grid-aligned box as a GeoJSON FeatureCollection for a map line layer. The snapshot changes only at epoch boundaries, and only road edges that the minimum number of attested installations drove in one cohort are included.',
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
    '/v2/traffic/status',
    {
      schema: {
        description:
          'Reports whether community traffic is off, collecting, or live, the upload rules the app must follow, and the publication rules. It reports no totals of segments, samples or contributors.',
        response: { 200: TrafficStatusResponseSchema },
        tags: ['traffic'],
      },
    },
    (_request, reply) => {
      reply.header('cache-control', 'public, max-age=60');
      return service.status();
    },
  );
}
