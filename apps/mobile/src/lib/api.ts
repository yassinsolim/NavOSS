import {
  CALGARY_TRAVEL_TIMES_SOURCE_ID,
  COMMUNITY_TRAFFIC_SOURCE_ID,
  compareRouteAlternatives,
  ContributionSubmissionResponseSchema,
  GooglePlaceQueryGrantResponseSchema,
  OfficialRoadEventResponseSchema,
  OfficialSafetyCameraResponseSchema,
  ProblemDetailsSchema,
  RoadEventResponseSchema,
  RouteResponseSchema,
  RouteResponseV2Schema,
  SafetyCameraResponseSchema,
  SafetyFacilityResponseSchema,
  SearchResponseSchema,
  serverConfigFromPayload,
  TrafficCameraResponseSchema,
  TrafficFlowResponseSchema,
  type ContributionSubmissionRequest,
  type ContributionSubmissionResponse,
  type GooglePlaceQueryGrantResponse,
  type OfficialRoadEventRegion,
  type OfficialRoadEventResponse,
  type OfficialSafetyCameraRegion,
  type OfficialSafetyCameraResponse,
  type RoadEventResponse,
  type RouteRequest,
  type RouteResponse,
  type RouteResponseV2,
  type SafetyCameraResponse,
  type SafetyFacilityRegion,
  type SafetyFacilityResponse,
  type SearchQuery,
  type SearchResponse,
  type ServerConfig,
  type TrafficCameraRegion,
  type TrafficCameraResponse,
  type TrafficFlowResponse,
} from '@navoss/contracts';

import { presentedInstruction } from '../features/navigation/instruction-text';

export class NavOssApiError extends Error {
  public readonly status: number;
  /** The problem's own title when the server explained the failure (`ProblemDetails`). */
  public readonly title: string | undefined;

  public constructor(message: string, status: number, title?: string) {
    super(message);
    this.name = 'NavOssApiError';
    this.status = status;
    this.title = title;
  }
}

/**
 * The API's answer to a body that does not match its contract (`app.ts` error handler), which is
 * how an API that predates an optional field (`trafficSources`, or origin heading and accuracy)
 * rejects it. A 400 with any other title is the server refusing the route itself ("No route
 * between these provinces"): sending it again without the optional fields gets the same answer.
 */
const CONTRACT_REJECTION_TITLE = 'Invalid request';

/**
 * The server's title when it refused to plan a route for a reason sending it again cannot change
 * (422 "No road route", 400 "No route between these provinces"); `undefined` for an outage, a
 * connection failure or a request the API could not read.
 */
export function routeRefusalTitle(error: unknown): string | undefined {
  if (!(error instanceof NavOssApiError) || error.title === undefined) return undefined;
  if (error.status === 422) return error.title;
  if (error.status === 400 && error.title !== CONTRACT_REJECTION_TITLE) return error.title;
  return undefined;
}

export interface SearchPlacesOptions {
  baseUrl?: string;
  category?: SearchQuery['category'];
  fetchImplementation?: typeof fetch;
  includeDetails?: boolean;
  latitude?: number;
  limit?: number;
  longitude?: number;
  signal?: AbortSignal;
  sort?: SearchQuery['sort'];
}

export interface FetchRoutesOptions {
  baseUrl?: string;
  fetchImplementation?: typeof fetch;
  /**
   * What the server's config declared. `false` goes straight to `/v1/routes`; `true` or unknown
   * asks `/v2/routes` first and falls back to `/v1/routes` on 404.
   */
  routesV2?: boolean;
  signal?: AbortSignal;
}

export interface FetchAppConfigOptions {
  baseUrl?: string;
  fetchImplementation?: typeof fetch;
  signal?: AbortSignal;
}

export interface FetchSafetyCamerasOptions {
  baseUrl?: string;
  fetchImplementation?: typeof fetch;
  signal?: AbortSignal;
}

export interface ReserveGooglePlaceQueryOptions {
  baseUrl?: string;
  fetchImplementation?: typeof fetch;
  signal?: AbortSignal;
}

export interface SubmitContributionOptions {
  baseUrl?: string;
  fetchImplementation?: typeof fetch;
  signal?: AbortSignal;
}

export interface FetchOfficialRoadEventsOptions extends FetchSafetyCamerasOptions {
  region: OfficialRoadEventRegion;
}

export interface FetchOfficialSafetyCamerasOptions extends FetchSafetyCamerasOptions {
  region: OfficialSafetyCameraRegion;
}

export interface FetchTrafficCamerasOptions extends FetchSafetyCamerasOptions {
  region: TrafficCameraRegion;
}

export interface FetchSafetyFacilitiesOptions extends FetchSafetyCamerasOptions {
  region: SafetyFacilityRegion;
}

export interface FetchTrafficFlowOptions extends FetchSafetyCamerasOptions {
  /** Grid-aligned `west,south,east,north` from `snapTrafficFlowBounds`. */
  bbox: string;
}

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, '');
}

export function resolveApiBaseUrl(
  configuredBaseUrl: unknown,
  developmentFallback?: string,
): string {
  if (typeof configuredBaseUrl !== 'string' || configuredBaseUrl.trim().length === 0) {
    if (developmentFallback !== undefined) {
      return developmentFallback;
    }

    throw new NavOssApiError(
      'This NavOSS build is missing its API configuration. Install a corrected build.',
      0,
    );
  }

  const normalizedBaseUrl = normalizeBaseUrl(configuredBaseUrl.trim());
  let parsedBaseUrl: URL;

  try {
    parsedBaseUrl = new URL(normalizedBaseUrl);
  } catch {
    throw new NavOssApiError('The NavOSS API URL is invalid.', 0);
  }

  if (parsedBaseUrl.protocol !== 'http:' && parsedBaseUrl.protocol !== 'https:') {
    throw new NavOssApiError('The NavOSS API URL must use HTTP or HTTPS.', 0);
  }

  if (developmentFallback === undefined && parsedBaseUrl.protocol !== 'https:') {
    throw new NavOssApiError('Release builds require an HTTPS NavOSS API URL.', 0);
  }

  return normalizedBaseUrl;
}

export function getApiBaseUrl(): string {
  const configuredBaseUrl: unknown = process.env.EXPO_PUBLIC_API_URL;
  return resolveApiBaseUrl(configuredBaseUrl, __DEV__ ? 'http://127.0.0.1:3001' : undefined);
}

export function buildSearchRequest(query: string, options: SearchPlacesOptions = {}) {
  return {
    ...(options.category === undefined ? {} : { category: options.category }),
    ...(options.includeDetails === true ? { includeDetails: true } : {}),
    ...(options.latitude !== undefined && options.longitude !== undefined
      ? { latitude: options.latitude, longitude: options.longitude }
      : {}),
    ...(options.limit === undefined ? {} : { limit: options.limit }),
    q: query,
    ...(options.sort === undefined ? {} : { sort: options.sort }),
  };
}

async function parseResponse(response: Response): Promise<unknown> {
  // An error from something in front of the API (a proxy's HTML 404 page) still carries its
  // status: a missing endpoint must read as 404, not as a malformed response.
  const payload: unknown = response.ok
    ? await response.json()
    : await response.json().catch(() => undefined);

  if (!response.ok) {
    const problem = ProblemDetailsSchema.safeParse(payload);
    throw new NavOssApiError(
      problem.success
        ? problem.data.detail
        : `NavOSS API request failed with ${String(response.status)}.`,
      response.status,
      problem.success ? problem.data.title : undefined,
    );
  }

  return payload;
}

/**
 * The server's declared capabilities and coverage, from any server generation: `/v2/config`, or
 * `/v1/config` on a server that predates it. See `server-config.ts` for the lenient model.
 */
export async function fetchAppConfig(options: FetchAppConfigOptions = {}): Promise<ServerConfig> {
  const fetchImplementation = options.fetchImplementation ?? fetch;
  const baseUrl = normalizeBaseUrl(options.baseUrl ?? getApiBaseUrl());
  const init = options.signal === undefined ? undefined : { signal: options.signal };
  const response = await fetchImplementation(`${baseUrl}/v2/config`, init);
  return serverConfigFromPayload(
    await parseResponse(
      response.status === 404 ? await fetchImplementation(`${baseUrl}/v1/config`, init) : response,
    ),
  );
}

export interface FetchAppConfigUntilKnownOptions extends FetchAppConfigOptions {
  /** Pauses between attempts; the last repeats until the config is known. */
  retryDelaysMs?: readonly number[];
  /** Told about each failed attempt, e.g. to show the service as unavailable meanwhile. */
  onFailure?: (error: unknown) => void;
  wait?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
}

const CONFIG_RETRY_DELAYS_MS = [2_000, 4_000, 8_000, 16_000, 30_000, 60_000] as const;

function waitFor(milliseconds: number, signal?: AbortSignal): Promise<void> {
  const { promise, resolve, reject } = Promise.withResolvers<undefined>();
  const timer = setTimeout(() => {
    resolve(undefined);
  }, milliseconds);
  signal?.addEventListener(
    'abort',
    () => {
      clearTimeout(timer);
      reject(signal.reason);
    },
    { once: true },
  );
  return promise;
}

/**
 * `fetchAppConfig`, tried again with backoff until the server answers or `signal` aborts. A server
 * that has just restarted answers 503 for a moment; without this, coverage stayed unknown until the
 * app was relaunched.
 */
export async function fetchAppConfigUntilKnown(
  options: FetchAppConfigUntilKnownOptions = {},
): Promise<ServerConfig> {
  const delays = options.retryDelaysMs ?? CONFIG_RETRY_DELAYS_MS;
  const wait = options.wait ?? waitFor;
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await fetchAppConfig(options);
    } catch (error: unknown) {
      if (options.signal?.aborted === true) throw error;
      options.onFailure?.(error);
      await wait(delays[Math.min(attempt, delays.length - 1)] ?? 60_000, options.signal);
    }
  }
}

export async function reserveGooglePlaceQuery(
  options: ReserveGooglePlaceQueryOptions = {},
): Promise<GooglePlaceQueryGrantResponse> {
  const fetchImplementation = options.fetchImplementation ?? fetch;
  const response = await fetchImplementation(
    `${normalizeBaseUrl(options.baseUrl ?? getApiBaseUrl())}/v1/google-place-query-grants`,
    {
      method: 'POST',
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    },
  );
  return GooglePlaceQueryGrantResponseSchema.parse(await parseResponse(response));
}

export async function submitContribution(
  request: ContributionSubmissionRequest,
  options: SubmitContributionOptions = {},
): Promise<ContributionSubmissionResponse> {
  const fetchImplementation = options.fetchImplementation ?? fetch;
  const response = await fetchImplementation(
    `${normalizeBaseUrl(options.baseUrl ?? getApiBaseUrl())}/v1/contributions`,
    {
      body: JSON.stringify(request),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    },
  );
  return ContributionSubmissionResponseSchema.parse(await parseResponse(response));
}

export async function searchPlaces(
  query: string,
  options: SearchPlacesOptions = {},
): Promise<SearchResponse> {
  const fetchImplementation = options.fetchImplementation ?? fetch;
  const response = await fetchImplementation(
    `${normalizeBaseUrl(options.baseUrl ?? getApiBaseUrl())}/v1/search`,
    {
      body: JSON.stringify(buildSearchRequest(query, options)),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    },
  );
  return SearchResponseSchema.parse(await parseResponse(response));
}

/**
 * Normalises a `/v1/routes` response to the `/v2/routes` shape. The fields line up except what a
 * step's `spokenInstruction` describes: v1 announces the *next* maneuver while driving a step, v2
 * describes the step's own maneuver. Native navigation speaks the v2 meaning.
 */
export function routeResponseFromV1(response: RouteResponse): RouteResponseV2 {
  return {
    ...response,
    routes: response.routes.map((route) => ({
      ...route,
      steps: route.steps.map((step, index) => {
        const shifted = { ...step };
        delete shifted.spokenInstruction;
        const spokenInstruction =
          index === 0 ? undefined : route.steps[index - 1]?.spokenInstruction;
        return spokenInstruction === undefined ? shifted : { ...shifted, spokenInstruction };
      }),
    })),
  };
}

async function isContractRejection(response: Response): Promise<boolean> {
  const problem = ProblemDetailsSchema.safeParse(await response.json().catch(() => undefined));
  return !problem.success || problem.data.title === CONTRACT_REJECTION_TITLE;
}

/**
 * Route traffic sources this client can present, declared in `/v2/routes` `trafficSources`. The
 * community source needs no declaration. Named one by one, not taken from the contract's list:
 * the client declares only what it has the wording and presentation for.
 */
export const PRESENTED_ROUTE_TRAFFIC_SOURCES: readonly string[] = [CALGARY_TRAVEL_TIMES_SOURCE_ID];

/** Every route traffic source the phone presents; any other id is treated as no traffic. */
const KNOWN_ROUTE_TRAFFIC_SOURCES: readonly string[] = [
  COMMUNITY_TRAFFIC_SOURCE_ID,
  CALGARY_TRAVEL_TIMES_SOURCE_ID,
];

type RouteRequestBody = RouteRequest & { trafficSources?: readonly string[] };

/**
 * API base URLs that rejected `trafficSources` with their contract 400 and answered the same
 * route request without it. Their route requests stop declaring for the rest of this app
 * session, so each does not pay a failed request first; the next launch declares again.
 */
const trafficSourcesRejectedBy = new Set<string>();

/**
 * The body to send once more after the API rejected `body` as not matching its contract, or
 * `undefined` when nothing optional is left to drop. It drops only the newest optional field the
 * body carries, so one field an older API does not know never costs the others:
 *
 * - `trafficSources` (2026-11-27), which the deployed API rejects until it learns it. Every API
 *   that serves `/v2/routes` accepts the origin metadata (both arrived in the contract in August
 *   2026, before `/v2/routes`), so a rejected v2 body that declared sources is that field.
 * - Otherwise the origin heading and accuracy, which an API older than August 2026 rejected
 *   (only ever on `/v1/routes`, which is never sent `trafficSources`).
 *
 * One retry at most, whatever the body carries.
 */
function withoutNewestOptionalField(body: RouteRequestBody): RouteRequestBody | undefined {
  if (body.trafficSources !== undefined) {
    const fallback = { ...body };
    delete fallback.trafficSources;
    return fallback;
  }
  if (
    body.originHeadingDegrees === undefined &&
    body.originHorizontalAccuracyMeters === undefined
  ) {
    return undefined;
  }
  const fallback = { ...body };
  delete fallback.originHeadingDegrees;
  delete fallback.originHorizontalAccuracyMeters;
  return fallback;
}

/**
 * A `/v2/routes` body whose route traffic comes from a source this client does not know is read
 * as a response without traffic: the source, its route delays and its congestion are dropped
 * rather than presented under another source's name. Everything else is left to the strict
 * contract parse.
 */
function withoutUnknownTrafficSource(payload: unknown): unknown {
  if (typeof payload !== 'object' || payload === null || !('source' in payload)) return payload;
  const { source } = payload;
  if (typeof source !== 'object' || source === null || !('trafficSource' in source)) {
    return payload;
  }
  const { trafficSource } = source;
  const id =
    typeof trafficSource === 'object' && trafficSource !== null && 'id' in trafficSource
      ? trafficSource.id
      : undefined;
  if (typeof id === 'string' && KNOWN_ROUTE_TRAFFIC_SOURCES.includes(id)) return payload;
  const plainSource: Record<string, unknown> = { ...source, traffic: 'unavailable' };
  delete plainSource.trafficSource;
  const routes = 'routes' in payload ? payload.routes : undefined;
  return {
    ...payload,
    routes: Array.isArray(routes)
      ? routes.map((route: unknown) => {
          if (typeof route !== 'object' || route === null) return route;
          const plainRoute: Record<string, unknown> = { ...route };
          delete plainRoute.congestion;
          delete plainRoute.traffic;
          return plainRoute;
        })
      : routes,
    source: plainSource,
  };
}

/**
 * Plans routes with `/v2/routes` (lanes, signposts, current road names, speed-limit states and
 * optional community or City of Calgary traffic). A server whose config declares only
 * `/v1/routes` is asked there directly; one that has not said answers 404 on `/v2/routes`, and
 * the request is sent to `/v1/routes` instead, so an older deployment keeps routing without the
 * extra detail.
 *
 * `/v2/routes` is told which extra traffic sources the phone presents
 * (`PRESENTED_ROUTE_TRAFFIC_SOURCES`). A body the API rejects as not matching its contract is
 * sent once more without its newest optional field (`withoutNewestOptionalField`).
 */
export async function fetchRoutes(
  request: RouteRequest,
  options: FetchRoutesOptions = {},
): Promise<RouteResponseV2> {
  const fetchImplementation = options.fetchImplementation ?? fetch;
  const baseUrl = normalizeBaseUrl(options.baseUrl ?? getApiBaseUrl());
  const send = async (path: string, body: RouteRequestBody) => {
    const post = (sent: RouteRequestBody) =>
      fetchImplementation(`${baseUrl}${path}`, {
        body: JSON.stringify(sent),
        headers: { 'content-type': 'application/json' },
        method: 'POST',
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      });
    const response = await post(body);
    const fallback = withoutNewestOptionalField(body);
    if (
      response.status !== 400 ||
      fallback === undefined ||
      !(await isContractRejection(response.clone()))
    ) {
      return response;
    }
    const retried = await post(fallback);
    // Answered without the declaration (a route, or "No road route"): the declaration was what
    // it rejected.
    if (body.trafficSources !== undefined && (retried.ok || retried.status === 422)) {
      trafficSourcesRejectedBy.add(baseUrl);
    }
    return retried;
  };
  const v2Response =
    options.routesV2 === false
      ? undefined
      : await send(
          '/v2/routes',
          trafficSourcesRejectedBy.has(baseUrl)
            ? request
            : { ...request, trafficSources: PRESENTED_ROUTE_TRAFFIC_SOURCES },
        );
  let validated: RouteResponseV2;
  if (v2Response === undefined || v2Response.status === 404) {
    validated = routeResponseFromV1(
      RouteResponseSchema.parse(await parseResponse(await send('/v1/routes', request))),
    );
    // The deployed server, which has only /v1/routes and no community traffic, may still order
    // routes by raw duration: re-apply the shared bucket-then-distance comparator so phone and
    // CarPlay present its routes in the order a current server would. Labels and durations are
    // untouched.
    validated.routes.sort(compareRouteAlternatives);
  } else {
    // A /v2/routes order is the server's recommendation, kept as sent: traffic may only reorder
    // routes within its own safety bounds (never onto more minor roads), and re-sorting by
    // duration here would undo them.
    validated = RouteResponseV2Schema.parse(
      withoutUnknownTrafficSource(await parseResponse(v2Response)),
    );
  }
  for (const route of validated.routes) {
    for (const step of route.steps) {
      step.instruction = presentedInstruction(step.instruction, step.maneuverType);
    }
  }
  return validated;
}

export async function fetchSafetyCameras(
  options: FetchSafetyCamerasOptions = {},
): Promise<SafetyCameraResponse> {
  const fetchImplementation = options.fetchImplementation ?? fetch;
  const response = await fetchImplementation(
    `${normalizeBaseUrl(options.baseUrl ?? getApiBaseUrl())}/v1/cameras`,
    options.signal === undefined ? undefined : { signal: options.signal },
  );
  return SafetyCameraResponseSchema.parse(await parseResponse(response));
}

export async function fetchRoadEvents(
  options: FetchSafetyCamerasOptions = {},
): Promise<RoadEventResponse> {
  const fetchImplementation = options.fetchImplementation ?? fetch;
  const response = await fetchImplementation(
    `${normalizeBaseUrl(options.baseUrl ?? getApiBaseUrl())}/v1/events`,
    options.signal === undefined ? undefined : { signal: options.signal },
  );
  return RoadEventResponseSchema.parse(await parseResponse(response));
}

export async function fetchOfficialRoadEvents(
  options: FetchOfficialRoadEventsOptions,
): Promise<OfficialRoadEventResponse> {
  const fetchImplementation = options.fetchImplementation ?? fetch;
  const searchParameters = new URLSearchParams({ region: options.region });
  const response = await fetchImplementation(
    `${normalizeBaseUrl(options.baseUrl ?? getApiBaseUrl())}/v2/events?${searchParameters.toString()}`,
    options.signal === undefined ? undefined : { signal: options.signal },
  );
  return OfficialRoadEventResponseSchema.parse(await parseResponse(response));
}

export async function fetchOfficialSafetyCameras(
  options: FetchOfficialSafetyCamerasOptions,
): Promise<OfficialSafetyCameraResponse> {
  const fetchImplementation = options.fetchImplementation ?? fetch;
  const response = await fetchImplementation(
    `${normalizeBaseUrl(options.baseUrl ?? getApiBaseUrl())}/v2/cameras?region=${encodeURIComponent(options.region)}`,
    options.signal === undefined ? undefined : { signal: options.signal },
  );
  return OfficialSafetyCameraResponseSchema.parse(await parseResponse(response));
}

export async function fetchTrafficCameras(
  options: FetchTrafficCamerasOptions,
): Promise<TrafficCameraResponse> {
  const fetchImplementation = options.fetchImplementation ?? fetch;
  const query = new URLSearchParams({ region: options.region });
  const response = await fetchImplementation(
    `${normalizeBaseUrl(options.baseUrl ?? getApiBaseUrl())}/v2/traffic-cameras?${query.toString()}`,
    options.signal === undefined ? undefined : { signal: options.signal },
  );
  return TrafficCameraResponseSchema.parse(await parseResponse(response));
}

/** Community traffic flow (`/v2/traffic/flow`). Ask only when the server declares live traffic. */
export async function fetchTrafficFlow(
  options: FetchTrafficFlowOptions,
): Promise<TrafficFlowResponse> {
  const fetchImplementation = options.fetchImplementation ?? fetch;
  const query = new URLSearchParams({ bbox: options.bbox });
  const response = await fetchImplementation(
    `${normalizeBaseUrl(options.baseUrl ?? getApiBaseUrl())}/v2/traffic/flow?${query.toString()}`,
    options.signal === undefined ? undefined : { signal: options.signal },
  );
  return TrafficFlowResponseSchema.parse(await parseResponse(response));
}

export async function fetchSafetyFacilities(
  options: FetchSafetyFacilitiesOptions,
): Promise<SafetyFacilityResponse> {
  const fetchImplementation = options.fetchImplementation ?? fetch;
  const query = new URLSearchParams({ region: options.region });
  const response = await fetchImplementation(
    `${normalizeBaseUrl(options.baseUrl ?? getApiBaseUrl())}/v2/safety-facilities?${query.toString()}`,
    options.signal === undefined ? undefined : { signal: options.signal },
  );
  return SafetyFacilityResponseSchema.parse(await parseResponse(response));
}
