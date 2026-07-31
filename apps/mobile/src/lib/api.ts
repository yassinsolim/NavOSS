import {
  AppConfigResponseSchema,
  ContributionSubmissionResponseSchema,
  GooglePlaceQueryGrantResponseSchema,
  OfficialRoadEventResponseSchema,
  OfficialSafetyCameraResponseSchema,
  ProblemDetailsSchema,
  RoadEventResponseSchema,
  RouteResponseSchema,
  SafetyCameraResponseSchema,
  SafetyFacilityResponseSchema,
  SearchResponseSchema,
  TrafficCameraResponseSchema,
  type AppConfigResponse,
  type ContributionSubmissionRequest,
  type ContributionSubmissionResponse,
  type GooglePlaceQueryGrantResponse,
  type OfficialRoadEventRegion,
  type OfficialRoadEventResponse,
  type OfficialSafetyCameraRegion,
  type OfficialSafetyCameraResponse,
  type RouteRequest,
  type RouteResponse,
  type RoadEventResponse,
  type SafetyCameraResponse,
  type SafetyFacilityRegion,
  type SafetyFacilityResponse,
  type SearchQuery,
  type SearchResponse,
  type TrafficCameraRegion,
  type TrafficCameraResponse,
} from '@navoss/contracts';

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
  const payload: unknown = await response.json();

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

export async function fetchAppConfig(signal?: AbortSignal): Promise<AppConfigResponse> {
  const response = await fetch(
    `${getApiBaseUrl()}/v1/config`,
    signal === undefined ? undefined : { signal },
  );
  return AppConfigResponseSchema.parse(await parseResponse(response));
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

export async function fetchRoutes(
  request: RouteRequest,
  options: FetchRoutesOptions = {},
): Promise<RouteResponse> {
  const fetchImplementation = options.fetchImplementation ?? fetch;
  const response = await fetchImplementation(
    `${normalizeBaseUrl(options.baseUrl ?? getApiBaseUrl())}/v1/routes`,
    {
      body: JSON.stringify(request),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    },
  );
  return RouteResponseSchema.parse(await parseResponse(response));
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
