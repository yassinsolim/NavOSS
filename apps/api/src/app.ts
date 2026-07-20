import fastifySwagger from '@fastify/swagger';
import {
  AppConfigResponseSchema,
  HealthResponseSchema,
  ProblemDetailsSchema,
  ReadinessResponseSchema,
  RouteRequestSchema,
  RouteResponseSchema,
  SafetyCameraResponseSchema,
  SearchQuerySchema,
  SearchResponseSchema,
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
import { createProblem } from './problem.js';
import {
  createValhallaRouteProvider,
  RouteProviderError,
  type RouteProvider,
} from './route-provider.js';
import {
  createDevelopmentSearchProvider,
  createProductionSearchProvider,
  type SearchProvider,
} from './search-provider.js';
import {
  CameraProviderError,
  createCalgarySafetyCameraProvider,
  type SafetyCameraProvider,
} from './safety-camera-provider.js';

const SERVICE_VERSION = '0.0.0';

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : 'UnknownError';
}

export interface BuildAppOptions {
  cameraProvider?: SafetyCameraProvider;
  clock?: () => Date;
  logger?: FastifyServerOptions['logger'];
  productionSearch?: boolean;
  routeProvider?: RouteProvider;
  searchProvider?: SearchProvider;
  searchFixtures?: readonly SearchFixture[];
}

export async function buildApp(options: BuildAppOptions = {}): Promise<FastifyInstance> {
  const clock = options.clock ?? (() => new Date());
  const cameraProvider = options.cameraProvider ?? createCalgarySafetyCameraProvider();
  const fixtures = options.searchFixtures ?? CALGARY_SEARCH_FIXTURES;
  const productionSearch = options.productionSearch ?? process.env.NOMINATIM_URL !== undefined;
  const routeProvider = options.routeProvider ?? createValhallaRouteProvider();
  const searchProvider =
    options.searchProvider ??
    (productionSearch
      ? createProductionSearchProvider(fixtures)
      : createDevelopmentSearchProvider(fixtures));
  const app = Fastify({
    logController: new LogController({ disableRequestLogging: true }),
    logger: options.logger ?? false,
  });

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  await app.register(fastifySwagger, {
    openapi: {
      info: {
        description: 'Privacy-first navigation services for the Calgary technical alpha.',
        title: 'NavOSS API',
        version: SERVICE_VERSION,
      },
      openapi: '3.1.0',
      tags: [
        { description: 'Official City of Calgary safety-camera locations', name: 'cameras' },
        { description: 'Application configuration', name: 'config' },
        { description: 'Driving route calculation and guidance', name: 'routes' },
        { description: 'Hybrid Calgary place and civic-address search', name: 'search' },
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
        description: 'Reports whether dependencies required by the technical alpha are ready.',
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
    '/v1/config',
    {
      schema: {
        description: 'Returns mobile-client coverage, feature, and attribution configuration.',
        response: { 200: AppConfigResponseSchema },
        tags: ['config'],
      },
    },
    () => createAppConfig(clock().toISOString(), productionSearch),
  );

  typedApp.post(
    '/v1/search',
    {
      schema: {
        description:
          'Searches indexed Calgary businesses, civic addresses, and OpenStreetMap places with a deterministic fallback.',
        body: SearchQuerySchema,
        response: {
          200: SearchResponseSchema,
          400: ProblemDetailsSchema,
        },
        tags: ['search'],
      },
    },
    (request) => searchProvider.search(request.body),
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
      try {
        const routes = await routeProvider.getRoutes(request.body);
        return {
          degraded: true as const,
          generatedAt: clock().toISOString(),
          routes,
          source: {
            attribution: 'Routing by Valhalla using OpenStreetMap data' as const,
            id: 'valhalla-development' as const,
            mode: 'development' as const,
            traffic: 'unavailable' as const,
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
