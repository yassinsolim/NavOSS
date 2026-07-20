import type { AppConfigResponse, SearchResult, SearchSource } from '@navoss/contracts';

export const SEARCH_SOURCE = {
  datasetVersion: 'fixture-v1',
  freshness: 'static',
  id: 'calgary-alpha-fixtures',
  updatedAt: '2026-07-15T12:00:00Z',
} as const satisfies SearchSource;

export interface SearchFixture {
  aliases: readonly string[];
  result: Omit<SearchResult, 'confidence'>;
}

export const CALGARY_SEARCH_FIXTURES = [
  {
    aliases: ['tower', 'calgary landmark'],
    result: {
      category: 'landmark',
      center: { latitude: 51.04427, longitude: -114.06309 },
      id: 'landmark:calgary-tower',
      label: 'Calgary Tower, 101 9 Avenue SW',
      name: 'Calgary Tower',
    },
  },
  {
    aliases: ['central library', 'new central library', 'library'],
    result: {
      category: 'poi',
      center: { latitude: 51.04513, longitude: -114.05789 },
      id: 'poi:calgary-central-library',
      label: 'Central Library, 800 3 Street SE',
      name: 'Central Library',
    },
  },
  {
    aliases: ['yyc', 'airport', 'calgary airport'],
    result: {
      category: 'poi',
      center: { latitude: 51.13157, longitude: -114.01055 },
      id: 'poi:yyc-airport',
      label: 'YYC Calgary International Airport',
      name: 'Calgary International Airport',
    },
  },
  {
    aliases: ['stampede', 'saddledome', 'calgary stampede'],
    result: {
      category: 'landmark',
      center: { latitude: 51.03746, longitude: -114.05193 },
      id: 'landmark:stampede-park',
      label: 'Stampede Park, 650 25 Avenue SE',
      name: 'Stampede Park',
    },
  },
  {
    aliases: ['u of c', 'ucalgary', 'university'],
    result: {
      category: 'poi',
      center: { latitude: 51.07795, longitude: -114.13073 },
      id: 'poi:university-of-calgary',
      label: 'University of Calgary, 2500 University Drive NW',
      name: 'University of Calgary',
    },
  },
  {
    aliases: ['chinook mall', 'mall', 'shopping'],
    result: {
      category: 'poi',
      center: { latitude: 50.99865, longitude: -114.07367 },
      id: 'poi:chinook-centre',
      label: 'CF Chinook Centre, 6455 Macleod Trail SW',
      name: 'CF Chinook Centre',
    },
  },
  {
    aliases: ['hospital', 'foothills hospital'],
    result: {
      category: 'poi',
      center: { latitude: 51.06534, longitude: -114.13308 },
      id: 'poi:foothills-medical-centre',
      label: 'Foothills Medical Centre, 1403 29 Street NW',
      name: 'Foothills Medical Centre',
    },
  },
  {
    aliases: ['east hills', 'east hills shopping', 'east hills shopping centre'],
    result: {
      category: 'poi',
      center: { latitude: 51.04112, longitude: -113.9132 },
      id: 'poi:east-hills-shopping-centre',
      label: 'East Hills Shopping Centre, East Hills Boulevard SE',
      name: 'East Hills Shopping Centre',
    },
  },
  {
    aliases: ['saddletowne', 'saddletowne lrt', 'saddletowne station'],
    result: {
      category: 'poi',
      center: { latitude: 51.12075, longitude: -113.94678 },
      id: 'poi:saddletowne-lrt',
      label: 'Saddletowne LRT Station, Saddletowne Circle NE',
      name: 'Saddletowne LRT Station',
    },
  },
  {
    aliases: ['downtown library', 'municipal building', 'city hall station'],
    result: {
      category: 'landmark',
      center: { latitude: 51.04645, longitude: -114.05758 },
      id: 'landmark:calgary-city-hall',
      label: 'Calgary City Hall, 800 Macleod Trail SE',
      name: 'Calgary City Hall',
    },
  },
  {
    aliases: ['17th ave', 'uptown 17th'],
    result: {
      category: 'street',
      center: { latitude: 51.03721, longitude: -114.08527 },
      id: 'street:17-avenue-sw',
      label: '17 Avenue SW, Calgary',
      name: '17 Avenue SW',
    },
  },
  {
    aliases: ['downtown south', '17th avenue district'],
    result: {
      category: 'neighborhood',
      center: { latitude: 51.04073, longitude: -114.08185 },
      id: 'neighborhood:beltline',
      label: 'Beltline, Calgary',
      name: 'Beltline',
    },
  },
] as const satisfies readonly SearchFixture[];

export function createAppConfig(generatedAt: string): AppConfigResponse {
  return {
    apiVersion: 'v1',
    attribution: [
      {
        label: 'OpenStreetMap contributors',
        url: 'https://www.openstreetmap.org/copyright',
      },
      {
        label: 'The City of Calgary',
        url: 'https://data.calgary.ca/',
      },
    ],
    coverage: {
      bounds: {
        northEast: { latitude: 51.212, longitude: -113.859 },
        southWest: { latitude: 50.842, longitude: -114.316 },
      },
      displayName: 'Calgary, Alberta',
      id: 'calgary-ab',
      modes: ['driving'],
    },
    endpoints: {
      cameras: '/v1/cameras',
      events: '/v1/events',
      routes: '/v1/routes',
      search: '/v1/search',
    },
    features: {
      communityReports: false,
      liveTraffic: false,
      officialSafetyCameras: true,
      productionSearch: false,
    },
    generatedAt,
    minimumAppVersion: '0.0.0',
    style: { id: 'navoss-alpha', version: 'fixture-v1' },
  };
}
