import { describe, expect, it } from 'vitest';

import { createKelownaSafetyFacilityProvider } from '../src/kelowna-safety-facility-provider.js';

describe('Kelowna safety facility provider', () => {
  it('returns exactly the two official fixed RCMP public facilities', async () => {
    const provider = createKelownaSafetyFacilityProvider({
      clock: () => Date.parse('2026-07-30T20:30:00Z'),
    });

    const response = await provider.getFacilities();

    expect(response.facilities).toEqual([
      expect.objectContaining({
        address: '1190 Richter St',
        kind: 'facility',
        name: 'Main Detachment',
        phone: '250-762-3300',
        type: 'police-station',
      }),
      expect.objectContaining({
        address: '115 McIntosh Rd',
        kind: 'facility',
        name: 'Rutland Community Police Office',
        phone: '250-765-6355',
        type: 'police-station',
      }),
    ]);
    expect(response.source).toMatchObject({
      dateModified: '2024-12-19',
      sourceUrl: 'https://rcmp.ca/en/bc/kelowna/contact',
    });
  });
});
