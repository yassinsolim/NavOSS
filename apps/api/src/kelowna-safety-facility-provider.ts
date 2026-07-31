import { SafetyFacilityResponseSchema, type SafetyFacilityResponse } from '@navoss/contracts';

export class KelownaSafetyFacilityProviderError extends Error {
  public constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'KelownaSafetyFacilityProviderError';
  }
}

export interface KelownaSafetyFacilityProvider {
  getFacilities(): Promise<SafetyFacilityResponse>;
}

interface KelownaSafetyFacilityProviderOptions {
  clock?: () => number;
}

export function createKelownaSafetyFacilityProvider(
  options: KelownaSafetyFacilityProviderOptions = {},
): KelownaSafetyFacilityProvider {
  const clock = options.clock ?? Date.now;
  return {
    getFacilities(): Promise<SafetyFacilityResponse> {
      return Promise.resolve(
        SafetyFacilityResponseSchema.parse({
          facilities: [
            {
              address: '1190 Richter St',
              coordinate: { latitude: 49.89385756349143, longitude: -119.48887718651372 },
              id: 'kelowna-rcmp:main-detachment',
              kind: 'facility',
              name: 'Main Detachment',
              pageUrl: 'https://rcmp.ca/en/bc/kelowna/contact',
              phone: '250-762-3300',
              regionId: 'kelowna-bc',
              type: 'police-station',
            },
            {
              address: '115 McIntosh Rd',
              coordinate: { latitude: 49.891982880689184, longitude: -119.38777082090141 },
              id: 'kelowna-rcmp:rutland-community-police-office',
              kind: 'facility',
              name: 'Rutland Community Police Office',
              pageUrl: 'https://rcmp.ca/en/bc/kelowna/contact',
              phone: '250-765-6355',
              regionId: 'kelowna-bc',
              type: 'police-station',
            },
          ],
          generatedAt: new Date(clock()).toISOString(),
          source: {
            attribution: 'Royal Canadian Mounted Police',
            dateModified: '2024-12-19',
            regionId: 'kelowna-bc',
            sourceId: 'kelowna-rcmp-public-facilities',
            sourceUrl: 'https://rcmp.ca/en/bc/kelowna/contact',
          },
        }),
      );
    },
  };
}
