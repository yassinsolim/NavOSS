import {
  CommunityAssertedRequestSchema,
  CommunityChallengeResponseSchema,
  CommunityDeletionResponseSchema,
  CommunityInstallationRegistrationRequestSchema,
  CommunityInstallationRegistrationResponseSchema,
  CommunityReportParamsSchema,
  CommunityReportQuerySchema,
  CommunityReportResponseSchema,
  CommunityReportSubmissionRequestSchema,
  CommunityReportSubmissionResponseSchema,
  CommunityReportVoteRequestSchema,
  CommunityReportVoteResponseSchema,
  ProblemDetailsSchema,
  type ProblemCode,
  type ProblemDetails,
} from '@navoss/contracts';
import type {
  FastifyBaseLogger,
  FastifyInstance,
  FastifyReply,
  FastifyRequest,
  RawReplyDefaultExpression,
  RawRequestDefaultExpression,
  RawServerDefault,
} from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';

import {
  CommunityReportError,
  type CommunityReportFailure,
  type CommunityReportService,
} from './community-reports.js';
import { networkBucket } from './community-trust.js';
import { createContributionRateLimiter } from './contribution-rate-limiter.js';
import { createProblem } from './problem.js';

type TypedApp = FastifyInstance<
  RawServerDefault,
  RawRequestDefaultExpression,
  RawReplyDefaultExpression,
  FastifyBaseLogger,
  ZodTypeProvider
>;

const FAILURES: Record<
  CommunityReportFailure,
  { code: ProblemCode; detail: string; status: number; title: string }
> = {
  'already-registered': {
    code: 'conflict',
    detail: 'This App Attest key is already registered. Generate a new key to register again.',
    status: 409,
    title: 'Installation already registered',
  },
  busy: {
    code: 'service_unavailable',
    detail: 'The request conflicted with concurrent reports. Request a new challenge and retry.',
    status: 503,
    title: 'Community reports busy',
  },
  attestation: {
    code: 'forbidden',
    detail: 'The device attestation or assertion could not be verified.',
    status: 403,
    title: 'Attestation rejected',
  },
  'development-not-allowed': {
    code: 'forbidden',
    detail: 'This server only accepts App Attest installations.',
    status: 403,
    title: 'Development attestation disabled',
  },
  'duplicate-vote': {
    code: 'conflict',
    detail: 'This installation has already voted on this report.',
    status: 409,
    title: 'Duplicate vote',
  },
  'impossible-travel': {
    code: 'forbidden',
    detail: 'The request is inconsistent with this installation’s recent activity.',
    status: 403,
    title: 'Report rejected',
  },
  'invalid-challenge': {
    code: 'unauthorized',
    detail: 'The challenge is unknown, expired, or already used. Request a new challenge.',
    status: 401,
    title: 'Invalid challenge',
  },
  'not-found': {
    code: 'not_found',
    detail: 'The report does not exist or is no longer active.',
    status: 404,
    title: 'Report not found',
  },
  'out-of-coverage': {
    code: 'invalid_request',
    detail: 'Community reports are accepted only inside the NavOSS coverage area.',
    status: 400,
    title: 'Report outside coverage',
  },
  'rate-limited': {
    code: 'rate_limited',
    detail: 'Too many community report writes. Try again later.',
    status: 429,
    title: 'Community reports rate limited',
  },
  replay: {
    code: 'forbidden',
    detail: 'The assertion counter did not advance; the request looks replayed.',
    status: 403,
    title: 'Assertion replay rejected',
  },
  'self-vote': {
    code: 'forbidden',
    detail: 'An installation cannot confirm or dispute its own report.',
    status: 403,
    title: 'Self-vote rejected',
  },
  'too-far': {
    code: 'invalid_request',
    detail: 'Votes are accepted only near the reported location.',
    status: 400,
    title: 'Vote too far from report',
  },
  unavailable: {
    code: 'service_unavailable',
    detail: 'Community reports are unavailable right now.',
    status: 503,
    title: 'Community reports unavailable',
  },
  'unknown-installation': {
    code: 'unauthorized',
    detail: 'This installation is not registered. Register a new App Attest key.',
    status: 401,
    title: 'Unknown installation',
  },
};

const PROBLEM_RESPONSES = {
  400: ProblemDetailsSchema,
  401: ProblemDetailsSchema,
  403: ProblemDetailsSchema,
  404: ProblemDetailsSchema,
  409: ProblemDetailsSchema,
  429: ProblemDetailsSchema,
  503: ProblemDetailsSchema,
} as const;

export const COMMUNITY_READS_PER_NETWORK_PER_HOUR = 1_200;

export interface CommunityRouteOptions {
  clock: () => Date;
  service: CommunityReportService | undefined;
}

export function registerCommunityRoutes(app: TypedApp, options: CommunityRouteOptions): void {
  const clockMs = (): number => options.clock().getTime();
  // In-memory network risk buckets (IPv4 /24, IPv6 /48), salted and hashed, never persisted.
  const writeLimiter = createContributionRateLimiter({
    clock: clockMs,
    globalLimit: 20_000,
    sourceLimit: 120,
  });
  const challengeLimiter = createContributionRateLimiter({
    clock: clockMs,
    globalLimit: 40_000,
    sourceLimit: 240,
  });
  // A phone polling once a minute makes 60 reads an hour; carrier NAT can share one bucket.
  const readLimiter = createContributionRateLimiter({
    clock: clockMs,
    globalLimit: 200_000,
    sourceLimit: COMMUNITY_READS_PER_NETWORK_PER_HOUR,
  });

  const fail = (
    request: FastifyRequest,
    reply: FastifyReply,
    reason: CommunityReportFailure,
  ): ProblemDetails => {
    const failure = FAILURES[reason];
    reply.status(failure.status).type('application/problem+json');
    if (failure.status === 429) reply.header('retry-after', '900');
    if (reason === 'busy') reply.header('retry-after', '1');
    return createProblem(request, failure.status, failure.code, failure.title, failure.detail);
  };

  const run = async <T>(
    request: FastifyRequest,
    reply: FastifyReply,
    limiter: { consume(source: string): boolean },
    work: (service: CommunityReportService) => Promise<T>,
  ): Promise<ProblemDetails | T> => {
    if (!limiter.consume(networkBucket(request.ip))) return fail(request, reply, 'rate-limited');
    if (options.service === undefined) return fail(request, reply, 'unavailable');
    try {
      return await work(options.service);
    } catch (error: unknown) {
      if (error instanceof CommunityReportError) {
        if (error.reason === 'unavailable') {
          request.log.error(
            {
              errorName: error.cause instanceof Error ? error.cause.name : 'Unavailable',
              requestId: request.id,
            },
            'Community reports unavailable',
          );
        }
        return fail(request, reply, error.reason);
      }
      throw error;
    }
  };

  app.post(
    '/v2/community/challenges',
    {
      schema: {
        description:
          'Issues a one-use five-minute challenge for App Attest registration or a write assertion.',
        response: { 200: CommunityChallengeResponseSchema, ...PROBLEM_RESPONSES },
        tags: ['community'],
      },
    },
    (request, reply) =>
      run(request, reply, challengeLimiter, (service) => service.issueChallenge()),
  );

  app.post(
    '/v2/community/installations',
    {
      schema: {
        body: CommunityInstallationRegistrationRequestSchema,
        description:
          'Registers a pseudonymous installation from an App Attest attestation. Development keys are accepted only when the server explicitly allows them and are untrusted.',
        response: { 201: CommunityInstallationRegistrationResponseSchema, ...PROBLEM_RESPONSES },
        tags: ['community'],
      },
    },
    (request, reply) =>
      run(request, reply, writeLimiter, async (service) => {
        const registered = await service.register(request.body);
        reply.status(201);
        return registered;
      }),
  );

  app.delete(
    '/v2/community/installations',
    {
      schema: {
        body: CommunityAssertedRequestSchema,
        description: 'Deletes the asserting installation together with its reports and votes.',
        response: { 200: CommunityDeletionResponseSchema, ...PROBLEM_RESPONSES },
        tags: ['community'],
      },
    },
    (request, reply) =>
      run(request, reply, writeLimiter, async (service) => {
        await service.deleteInstallation(request.body.assertion);
        return { status: 'deleted' as const };
      }),
  );

  app.get(
    '/v2/community/reports',
    {
      schema: {
        description:
          'Returns active community road reports inside a bounding box under the server publication policy. Community reports are unofficial and never change routes.',
        querystring: CommunityReportQuerySchema,
        response: { 200: CommunityReportResponseSchema, ...PROBLEM_RESPONSES },
        tags: ['community'],
      },
    },
    (request, reply) =>
      run(request, reply, readLimiter, (service) => service.nearby(request.query)),
  );

  app.post(
    '/v2/community/reports',
    {
      schema: {
        body: CommunityReportSubmissionRequestSchema,
        description:
          'Submits a structured community road report with a fresh assertion. A nearby same-type report from another installation is confirmed instead of duplicated.',
        response: { 201: CommunityReportSubmissionResponseSchema, ...PROBLEM_RESPONSES },
        tags: ['community'],
      },
    },
    (request, reply) =>
      run(request, reply, writeLimiter, async (service) => {
        const accepted = await service.submit(request.body);
        reply.status(201);
        return accepted;
      }),
  );

  app.post(
    '/v2/community/reports/:reportId/votes',
    {
      schema: {
        body: CommunityReportVoteRequestSchema,
        description:
          'Records one still-there or not-there vote from a nearby installation. The observation coordinate is checked and discarded.',
        params: CommunityReportParamsSchema,
        response: { 200: CommunityReportVoteResponseSchema, ...PROBLEM_RESPONSES },
        tags: ['community'],
      },
    },
    (request, reply) =>
      run(request, reply, writeLimiter, (service) =>
        service.vote(request.params.reportId, request.body),
      ),
  );

  app.delete(
    '/v2/community/reports/:reportId',
    {
      schema: {
        body: CommunityAssertedRequestSchema,
        description: 'Withdraws a report submitted by the asserting installation.',
        params: CommunityReportParamsSchema,
        response: { 200: CommunityDeletionResponseSchema, ...PROBLEM_RESPONSES },
        tags: ['community'],
      },
    },
    (request, reply) =>
      run(request, reply, writeLimiter, async (service) => {
        await service.deleteReport(request.params.reportId, request.body.assertion);
        return { status: 'deleted' as const };
      }),
  );
}
