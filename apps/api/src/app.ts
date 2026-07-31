import fastifySwagger from '@fastify/swagger';
import {
  AppConfigResponseSchema,
  ContributionSubmissionRequestSchema,
  ContributionSubmissionResponseSchema,
  GooglePlaceQueryGrantResponseSchema,
  HealthResponseSchema,
  OfficialRoadEventQuerySchema,
  OfficialRoadEventResponseSchema,
  OfficialSafetyCameraQuerySchema,
  OfficialSafetyCameraResponseSchema,
  ProblemDetailsSchema,
  ReadinessResponseSchema,
  RoadEventResponseSchema,
  SafetyFacilityQuerySchema,
  SafetyFacilityResponseSchema,
  RouteRequestSchema,
  RouteResponseSchema,
  SafetyCameraResponseSchema,
  SearchQuerySchema,
  SearchResponseSchema,
  TrafficCameraQuerySchema,
  TrafficCameraResponseSchema,
  type ReadinessResponse,
} from '@navoss/contracts';
import Fastify, { LogController, type FastifyInstance, type FastifyServerOptions } from 'fastify';
import {
  hasZodFastifySchemaValidationErrors,
  isResponseSerializationError,
  jsonSchemaTransform,
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from 'fastify-type-provider-zod';

import { CALGARY_SEARCH_FIXTURES, createAppConfig, type SearchFixture } from './fixtures.js';
import {
  ContributionProviderError,
  createConfiguredContributionProvider,
  type ContributionProvider,
} from './contribution-provider.js';
import {
  createContributionRateLimiter,
  type ContributionRateLimiter,
} from './contribution-rate-limiter.js';
import {
  createConfiguredGooglePlaceQueryBudget,
  type GooglePlaceQueryBudget,
} from './google-place-query-budget.js';
import {
  CalgaryRoadEventProviderError,
  createCalgaryRoadEventProvider,
  type CalgaryRoadEventProvider,
} from './calgary-road-event-provider.js';
import {
  createOntarioRoadEventProvider,
  OntarioRoadEventProviderError,
  type OntarioRoadEventProvider,
} from './ontario-road-event-provider.js';
import {
  createDriveBcRoadEventProvider,
  DriveBcRoadEventProviderError,
  type DriveBcRoadEventProvider,
} from './drivebc-road-event-provider.js';
import {
  createDriveBcTrafficCameraProvider,
  DriveBcTrafficCameraProviderError,
  type DriveBcTrafficCameraProvider,
} from './drivebc-traffic-camera-provider.js';
import {
  createKelownaSafetyFacilityProvider,
  KelownaSafetyFacilityProviderError,
  type KelownaSafetyFacilityProvider,
} from './kelowna-safety-facility-provider.js';
import { createProblem } from './problem.js';
import {
  createConfiguredRouteProvider,
  RouteProviderError,
  type RouteProvider,
} from './route-provider.js';
import {
  createDevelopmentSearchProvider,
  isSupportedSearchCoordinate,
  createProductionSearchProvider,
  type SearchProvider,
} from './search-provider.js';
import {
  CameraProviderError,
  createCalgarySafetyCameraProvider,
  type SafetyCameraProvider,
} from './safety-camera-provider.js';
import {
  createTorontoSafetyCameraProvider,
  TorontoCameraProviderError,
  type TorontoSafetyCameraProvider,
} from './toronto-safety-camera-provider.js';

const SERVICE_VERSION = '0.0.0';

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : 'UnknownError';
}

export interface BuildAppOptions {
  cameraProvider?: SafetyCameraProvider;
  clock?: () => Date;
  contributionProvider?: ContributionProvider;
  contributionRateLimiter?: ContributionRateLimiter;
  driveBcEventProvider?: DriveBcRoadEventProvider;
  driveBcTrafficCameraProvider?: DriveBcTrafficCameraProvider;
  eventProvider?: CalgaryRoadEventProvider;
  googlePlaceQueryBudget?: GooglePlaceQueryBudget;
  logger?: FastifyServerOptions['logger'];
  kelownaSafetyFacilityProvider?: KelownaSafetyFacilityProvider;
  ontarioEventProvider?: OntarioRoadEventProvider;
  productionSearch?: boolean;
  routeProvider?: RouteProvider;
  searchProvider?: SearchProvider;
  searchFixtures?: readonly SearchFixture[];
  torontoCameraProvider?: TorontoSafetyCameraProvider;
}

export async function buildApp(options: BuildAppOptions = {}): Promise<FastifyInstance> {
  const clock = options.clock ?? (() => new Date());
  const cameraProvider = options.cameraProvider ?? createCalgarySafetyCameraProvider();
  const contributionProvider =
    options.contributionProvider ?? createConfiguredContributionProvider({ clock });
  const contributionRateLimiter =
    options.contributionRateLimiter ??
    createContributionRateLimiter({ clock: () => clock().getTime() });
  const driveBcEventProvider = options.driveBcEventProvider ?? createDriveBcRoadEventProvider();
  const driveBcTrafficCameraProvider =
    options.driveBcTrafficCameraProvider ?? createDriveBcTrafficCameraProvider();
  const eventProvider = options.eventProvider ?? createCalgaryRoadEventProvider();
  const fixtures = options.searchFixtures ?? CALGARY_SEARCH_FIXTURES;
  const googlePlaceQueryBudget =
    options.googlePlaceQueryBudget ?? createConfiguredGooglePlaceQueryBudget({ clock });
  const ontarioEventProvider = options.ontarioEventProvider ?? createOntarioRoadEventProvider();
  const kelownaSafetyFacilityProvider =
    options.kelownaSafetyFacilityProvider ?? createKelownaSafetyFacilityProvider();
  const productionSearch = options.productionSearch ?? process.env.NOMINATIM_URL !== undefined;
  const routeProvider = options.routeProvider ?? createConfiguredRouteProvider();
  const liveTraffic = routeProvider.source?.traffic === 'live';
  const searchProvider =
    options.searchProvider ??
    (productionSearch
      ? createProductionSearchProvider(fixtures)
      : createDevelopmentSearchProvider(fixtures));
  const torontoCameraProvider =
    options.torontoCameraProvider ?? createTorontoSafetyCameraProvider();
  const app = Fastify({
    logController: new LogController({ disableRequestLogging: true }),
    logger: options.logger ?? false,
    trustProxy: 'loopback, linklocal, uniquelocal',
  });

  app.addHook('onClose', async () => {
    driveBcEventProvider.stop?.();
    driveBcTrafficCameraProvider.stop?.();
    eventProvider.stop?.();
    ontarioEventProvider.stop?.();
    await Promise.all([contributionProvider.close?.(), googlePlaceQueryBudget.close?.()]);
  });

  app.addHook('onReady', () => {
    contributionProvider.start?.();
  });

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  await app.register(fastifySwagger, {
    openapi: {
      info: {
        description: 'Privacy-first navigation services for the NavOSS technical beta.',
        title: 'NavOSS API',
        version: SERVICE_VERSION,
      },
      openapi: '3.1.0',
      tags: [
        { description: 'Official municipal safety-camera locations', name: 'cameras' },
        { description: 'Application configuration', name: 'config' },
        { description: 'Anonymous bounded beta feedback submissions', name: 'contributions' },
        { description: 'Official and source-qualified road events', name: 'events' },
        { description: 'Fixed official public safety facilities', name: 'facilities' },
        { description: 'Privacy-preserving optional place enrichment', name: 'places' },
        { description: 'Driving route calculation and guidance', name: 'routes' },
        { description: 'Regional OpenStreetMap search with Calgary civic data', name: 'search' },
        { description: 'Service health and readiness', name: 'system' },
      ],
    },
    transform: jsonSchemaTransform,
  });

  app.setErrorHandler((error, request, reply) => {
    if (hasZodFastifySchemaValidationErrors(error)) {
      return reply
        .status(400)
        .type('application/problem+json')
        .send(
          createProblem(
            request,
            400,
            'invalid_request',
            'Invalid request',
            'The request does not match the API contract.',
          ),
        );
    }

    if (isResponseSerializationError(error)) {
      request.log.error(
        { errorName: errorName(error), requestId: request.id },
        'Response failed contract validation',
      );
      return reply
        .status(500)
        .type('application/problem+json')
        .send(
          createProblem(
            request,
            500,
            'internal_error',
            'Internal server error',
            'The service could not produce a valid response.',
          ),
        );
    }

    request.log.error(
      { errorName: errorName(error), requestId: request.id },
      'Unhandled request error',
    );
    return reply
      .status(500)
      .type('application/problem+json')
      .send(
        createProblem(
          request,
          500,
          'internal_error',
          'Internal server error',
          'The service could not complete the request.',
        ),
      );
  });

  app.setNotFoundHandler((request, reply) =>
    reply
      .status(404)
      .type('application/problem+json')
      .send(
        createProblem(
          request,
          404,
          'not_found',
          'Not found',
          'The requested resource does not exist.',
        ),
      ),
  );

  const typedApp = app.withTypeProvider<ZodTypeProvider>();

  typedApp.get(
    '/health',
    {
      schema: {
        description: 'Reports whether the API process is alive.',
        response: { 200: HealthResponseSchema },
        tags: ['system'],
      },
    },
    () => ({
      service: 'navoss-api' as const,
      status: 'ok' as const,
      timestamp: clock().toISOString(),
      version: SERVICE_VERSION,
    }),
  );

  typedApp.get(
    '/ready',
    {
      schema: {
        description: 'Reports whether dependencies required by the technical beta are ready.',
        response: {
          200: ReadinessResponseSchema,
          503: ReadinessResponseSchema,
        },
        tags: ['system'],
      },
    },
    async (request, reply) => {
      const timestamp = clock().toISOString();
      const searchFixturesReady = fixtures.length > 0;
      const routingProviderReady =
        routeProvider.isReady === undefined ? undefined : await routeProvider.isReady();
      const searchProviderReady =
        productionSearch && searchProvider.isReady !== undefined
          ? await searchProvider.isReady()
          : productionSearch
            ? false
            : undefined;
      const isReady =
        searchFixturesReady && routingProviderReady !== false && searchProviderReady !== false;

      if (!isReady) {
        reply.status(503);
      } else {
        reply.status(200);
      }

      const response: ReadinessResponse = {
        checks: {
          ...(routingProviderReady === undefined
            ? {}
            : {
                routingProvider: {
                  detail: routingProviderReady
                    ? 'The routing provider is reachable.'
                    : 'The routing provider is unavailable.',
                  status: routingProviderReady ? ('ready' as const) : ('not_ready' as const),
                },
              }),
          ...(searchProviderReady === undefined
            ? {}
            : {
                searchProvider: {
                  detail: searchProviderReady
                    ? 'The production search provider is reachable.'
                    : 'The production search provider is unavailable.',
                  status: searchProviderReady ? ('ready' as const) : ('not_ready' as const),
                },
              }),
          searchFixtures: {
            detail: searchFixturesReady
              ? `${String(fixtures.length)} Calgary search fixtures loaded.`
              : 'No Calgary search fixtures are loaded.',
            status: searchFixturesReady ? 'ready' : 'not_ready',
          },
        },
        status: isReady ? 'ready' : 'not_ready',
        timestamp,
      };
      return response;
    },
  );

  typedApp.get(
    '/v1/cameras',
    {
      schema: {
        description: 'Returns official Calgary red-light and speed-on-green camera locations.',
        response: {
          200: SafetyCameraResponseSchema,
          503: ProblemDetailsSchema,
        },
        tags: ['cameras'],
      },
    },
    async (request, reply) => {
      try {
        return await cameraProvider.getCameras();
      } catch (error: unknown) {
        if (error instanceof CameraProviderError) {
          reply.status(503).type('application/problem+json');
          return createProblem(
            request,
            503,
            'service_unavailable',
            'Camera data unavailable',
            'Official Calgary safety-camera data could not be loaded right now.',
          );
        }

        throw error;
      }
    },
  );

  typedApp.get(
    '/v1/events',
    {
      schema: {
        description:
          'Returns source-qualified Calgary construction and current traffic incidents with freshness metadata.',
        response: {
          200: RoadEventResponseSchema,
          503: ProblemDetailsSchema,
        },
        tags: ['events'],
      },
    },
    async (request, reply) => {
      try {
        return await eventProvider.getRoadEvents();
      } catch (error: unknown) {
        if (error instanceof CalgaryRoadEventProviderError) {
          reply.status(503).type('application/problem+json');
          return createProblem(
            request,
            503,
            'service_unavailable',
            'Road data unavailable',
            'Official Calgary road-event data could not be loaded right now.',
          );
        }
        throw error;
      }
    },
  );

  typedApp.get(
    '/v2/events',
    {
      schema: {
        description:
          'Returns official Ontario 511 or DriveBC Open511 construction, closure, and incident points with freshness metadata.',
        querystring: OfficialRoadEventQuerySchema,
        response: {
          200: OfficialRoadEventResponseSchema,
          503: ProblemDetailsSchema,
        },
        tags: ['events'],
      },
    },
    async (request, reply) => {
      try {
        return request.query.region === 'ontario'
          ? await ontarioEventProvider.getRoadEvents()
          : await driveBcEventProvider.getRoadEvents();
      } catch (error: unknown) {
        if (error instanceof OntarioRoadEventProviderError) {
          reply.status(503).type('application/problem+json');
          return createProblem(
            request,
            503,
            'service_unavailable',
            'Road data unavailable',
            'Official Ontario 511 road-event data could not be loaded right now.',
          );
        }
        if (error instanceof DriveBcRoadEventProviderError) {
          reply.status(503).type('application/problem+json');
          return createProblem(
            request,
            503,
            'service_unavailable',
            'Road data unavailable',
            'Official DriveBC Open511 road-event data could not be loaded right now.',
          );
        }
        throw error;
      }
    },
  );

  typedApp.get(
    '/v1/config',
    {
      schema: {
        description: 'Returns mobile-client coverage, feature, and attribution configuration.',
        response: { 200: AppConfigResponseSchema },
        tags: ['config'],
      },
    },
    () => createAppConfig(clock().toISOString(), productionSearch, liveTraffic),
  );

  typedApp.post(
    '/v1/google-place-query-grants',
    {
      schema: {
        description:
          'Atomically reserves one anonymous Google Places UI Kit query under the monthly no-charge safety cap.',
        response: {
          200: GooglePlaceQueryGrantResponseSchema,
          503: ProblemDetailsSchema,
        },
        tags: ['places'],
      },
    },
    async (request, reply) => {
      try {
        return await googlePlaceQueryBudget.reserve();
      } catch {
        reply.status(503).type('application/problem+json');
        return createProblem(
          request,
          503,
          'service_unavailable',
          'Place details unavailable',
          'The optional Google place-details budget could not be reserved right now.',
        );
      }
    },
  );

  typedApp.post(
    '/v1/contributions',
    {
      schema: {
        body: ContributionSubmissionRequestSchema,
        description:
          'Accepts anonymous bounded beta feedback without accounts, device identifiers, or precise coordinates.',
        response: {
          202: ContributionSubmissionResponseSchema,
          429: ProblemDetailsSchema,
          503: ProblemDetailsSchema,
        },
        tags: ['contributions'],
      },
    },
    async (request, reply) => {
      if (!contributionRateLimiter.consume(request.ip)) {
        reply.status(429).header('retry-after', '3600').type('application/problem+json');
        return createProblem(
          request,
          429,
          'rate_limited',
          'Feedback submission rate limited',
          'Too many beta feedback submissions were received. Keep the local draft and try again later.',
        );
      }
      try {
        const accepted = await contributionProvider.submit(request.body);
        reply.status(202);
        return accepted;
      } catch (error: unknown) {
        if (error instanceof ContributionProviderError) {
          reply.status(503).type('application/problem+json');
          return createProblem(
            request,
            503,
            'service_unavailable',
            'Feedback submission unavailable',
            error.reason === 'full'
              ? 'The beta feedback queue is temporarily full. Keep the local draft and try again later.'
              : 'The beta feedback could not be stored right now. Keep the local draft and try again later.',
          );
        }
        throw error;
      }
    },
  );

  typedApp.get(
    '/v2/cameras',
    {
      schema: {
        description:
          'Returns official regional safety-camera locations with source-specific enforcement and direction fields.',
        querystring: OfficialSafetyCameraQuerySchema,
        response: {
          200: OfficialSafetyCameraResponseSchema,
          503: ProblemDetailsSchema,
        },
        tags: ['cameras'],
      },
    },
    async (request, reply) => {
      try {
        return await torontoCameraProvider.getCameras();
      } catch (error: unknown) {
        if (error instanceof TorontoCameraProviderError) {
          reply.status(503).type('application/problem+json');
          return createProblem(
            request,
            503,
            'service_unavailable',
            'Camera data unavailable',
            'Official Toronto red-light-camera data could not be loaded right now.',
          );
        }

        throw error;
      }
    },
  );

  typedApp.get(
    '/v2/traffic-cameras',
    {
      schema: {
        description:
          'Returns ordinary DriveBC HighwayCams traffic imagery locations. These are not enforcement cameras.',
        querystring: TrafficCameraQuerySchema,
        response: {
          200: TrafficCameraResponseSchema,
          503: ProblemDetailsSchema,
        },
        tags: ['cameras'],
      },
    },
    async (request, reply) => {
      try {
        return await driveBcTrafficCameraProvider.getCameras();
      } catch (error: unknown) {
        if (error instanceof DriveBcTrafficCameraProviderError) {
          reply.status(503).type('application/problem+json');
          return createProblem(
            request,
            503,
            'service_unavailable',
            'Traffic camera data unavailable',
            'Official DriveBC HighwayCams data could not be loaded right now.',
          );
        }
        throw error;
      }
    },
  );

  typedApp.get(
    '/v2/safety-facilities',
    {
      schema: {
        description:
          'Returns fixed official public RCMP facility locations in Kelowna. This is not live police or checkpoint data.',
        querystring: SafetyFacilityQuerySchema,
        response: {
          200: SafetyFacilityResponseSchema,
          503: ProblemDetailsSchema,
        },
        tags: ['facilities'],
      },
    },
    async (request, reply) => {
      try {
        return await kelownaSafetyFacilityProvider.getFacilities();
      } catch (error: unknown) {
        if (error instanceof KelownaSafetyFacilityProviderError) {
          reply.status(503).type('application/problem+json');
          return createProblem(
            request,
            503,
            'service_unavailable',
            'Safety facility data unavailable',
            'Official Kelowna RCMP facility data could not be loaded right now.',
          );
        }
        throw error;
      }
    },
  );

  typedApp.post(
    '/v1/search',
    {
      schema: {
        description:
          'Searches regional OpenStreetMap places plus indexed Calgary businesses and civic addresses.',
        body: SearchQuerySchema,
        response: {
          200: SearchResponseSchema,
          400: ProblemDetailsSchema,
        },
        tags: ['search'],
      },
    },
    (request, reply) => {
      const { category, latitude, longitude } = request.body;
      if (category !== undefined && (latitude === undefined || longitude === undefined)) {
        reply.status(400).type('application/problem+json');
        return createProblem(
          request,
          400,
          'invalid_request',
          'Nearby search needs a location',
          'Nearby categories require a supported search origin.',
        );
      }
      if (
        category !== undefined &&
        latitude !== undefined &&
        longitude !== undefined &&
        !isSupportedSearchCoordinate({ latitude, longitude })
      ) {
        reply.status(400).type('application/problem+json');
        return createProblem(
          request,
          400,
          'invalid_request',
          'Search outside coverage',
          'Nearby categories are currently available only in the Calgary and Kelowna service areas.',
        );
      }
      return searchProvider.search(request.body);
    },
  );

  typedApp.post(
    '/v1/routes',
    {
      schema: {
        body: RouteRequestSchema,
        description: 'Calculates driving route alternatives for preview and guidance.',
        response: {
          200: RouteResponseSchema,
          400: ProblemDetailsSchema,
          503: ProblemDetailsSchema,
        },
        tags: ['routes'],
      },
    },
    async (request, reply) => {
      const routeCoordinates = [
        request.body.origin,
        ...(request.body.waypoints ?? []),
        request.body.destination,
      ];
      if (routeCoordinates.some((coordinate) => !isSupportedSearchCoordinate(coordinate))) {
        reply.status(400).type('application/problem+json');
        return createProblem(
          request,
          400,
          'invalid_request',
          'Route outside coverage',
          'Driving routes are currently available only between supported Calgary and Kelowna area locations.',
        );
      }
      try {
        const routes = await routeProvider.getRoutes(request.body);
        const source = routeProvider.source ?? {
          attribution: 'Routing by Valhalla using OpenStreetMap data' as const,
          degraded: true,
          id: 'valhalla-development' as const,
          mode: 'development' as const,
          traffic: 'unavailable' as const,
        };
        return {
          degraded: source.degraded,
          generatedAt: clock().toISOString(),
          routes,
          source: {
            attribution: source.attribution,
            id: source.id,
            mode: source.mode,
            traffic: source.traffic,
          },
        };
      } catch (error: unknown) {
        if (error instanceof RouteProviderError) {
          reply.status(503).type('application/problem+json');
          return createProblem(
            request,
            503,
            'service_unavailable',
            'Routing unavailable',
            'A driving route could not be calculated right now.',
          );
        }

        throw error;
      }
    },
  );

  typedApp.get(
    '/openapi.json',
    {
      schema: { hide: true },
    },
    () => app.swagger(),
  );

  await app.ready();
  return app;
}
