import {
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

  public constructor(message: string, status: number) {
    super(message);
    this.name = 'NavOssApiError';
    this.status = status;
  }
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

/**
 * Plans routes with `/v2/routes` (lanes, signposts, current road names, speed-limit states and
 * optional community traffic). A server whose config declares only `/v1/routes` is asked there
 * directly; one that has not said answers 404 on `/v2/routes`, and the request is sent to
 * `/v1/routes` instead, so an older deployment keeps routing without the extra detail.
 */
export async function fetchRoutes(
  request: RouteRequest,
  options: FetchRoutesOptions = {},
): Promise<RouteResponseV2> {
  const fetchImplementation = options.fetchImplementation ?? fetch;
  const baseUrl = normalizeBaseUrl(options.baseUrl ?? getApiBaseUrl());
  const send = async (path: string) => {
    const post = (body: RouteRequest) =>
      fetchImplementation(`${baseUrl}${path}`, {
        body: JSON.stringify(body),
        headers: { 'content-type': 'application/json' },
        method: 'POST',
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      });
    const response = await post(request);
    if (
      response.status !== 400 ||
      (request.originHeadingDegrees === undefined &&
        request.originHorizontalAccuracyMeters === undefined)
    ) {
      return response;
    }
    const fallback = { ...request };
    delete fallback.originHeadingDegrees;
    delete fallback.originHorizontalAccuracyMeters;
    return post(fallback);
  };
  const v2Response = options.routesV2 === false ? undefined : await send('/v2/routes');
  let validated: RouteResponseV2;
  if (v2Response === undefined || v2Response.status === 404) {
    validated = routeResponseFromV1(
      RouteResponseSchema.parse(await parseResponse(await send('/v1/routes'))),
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
    validated = RouteResponseV2Schema.parse(await parseResponse(v2Response));
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
