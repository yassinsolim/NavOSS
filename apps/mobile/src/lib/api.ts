import {
  AppConfigResponseSchema,
  ProblemDetailsSchema,
  RouteResponseSchema,
  SearchResponseSchema,
  type AppConfigResponse,
  type RouteRequest,
  type RouteResponse,
  type SearchResponse,
} from '@navoss/contracts';

const DEFAULT_API_BASE_URL = 'http://127.0.0.1:3000';

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
  latitude?: number;
  limit?: number;
  longitude?: number;
  signal?: AbortSignal;
}

export interface FetchRoutesOptions {
  baseUrl?: string;
  fetchImplementation?: typeof fetch;
  signal?: AbortSignal;
}

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, '');
}

export function getApiBaseUrl(): string {
  const configuredBaseUrl: unknown = process.env.EXPO_PUBLIC_API_URL;
  return normalizeBaseUrl(
    typeof configuredBaseUrl === 'string' ? configuredBaseUrl : DEFAULT_API_BASE_URL,
  );
}

export function buildSearchUrl(query: string, options: SearchPlacesOptions = {}): string {
  const parameters = new URLSearchParams({ q: query });

  if (options.latitude !== undefined && options.longitude !== undefined) {
    parameters.set('latitude', String(options.latitude));
    parameters.set('longitude', String(options.longitude));
  }

  if (options.limit !== undefined) {
    parameters.set('limit', String(options.limit));
  }

  return `${normalizeBaseUrl(options.baseUrl ?? getApiBaseUrl())}/v1/search?${parameters.toString()}`;
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

export async function searchPlaces(
  query: string,
  options: SearchPlacesOptions = {},
): Promise<SearchResponse> {
  const response = await fetch(
    buildSearchUrl(query, options),
    options.signal === undefined ? undefined : { signal: options.signal },
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
