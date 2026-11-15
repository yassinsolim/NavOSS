import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const { googlePlacesBuildConfiguration } = require('../plugins/with-navoss-carplay.cjs');

describe('Google Places build configuration', () => {
  it('is disabled and keyless by default', () => {
    expect(googlePlacesBuildConfiguration({})).toEqual({ enabled: false });
  });

  it('fails closed inside the EAS build job when enabled without a key', () => {
    for (const EAS_BUILD of ['true', '1']) {
      expect(() =>
        googlePlacesBuildConfiguration({ EAS_BUILD, NAVOSS_GOOGLE_PLACES_ENABLED: '1' }),
      ).toThrow('GOOGLE_PLACES_IOS_API_KEY is required');
      expect(() =>
        googlePlacesBuildConfiguration({
          EAS_BUILD,
          GOOGLE_PLACES_IOS_API_KEY: '   ',
          NAVOSS_GOOGLE_PLACES_ENABLED: '1',
        }),
      ).toThrow('GOOGLE_PLACES_IOS_API_KEY is required');
    }
  });

  it('lets the EAS CLI evaluate the config where the secret key is not readable', () => {
    // Hosted run 43677906278 died at `expo config --json` on the runner before the build job.
    expect(googlePlacesBuildConfiguration({ NAVOSS_GOOGLE_PLACES_ENABLED: '1' })).toEqual({
      enabled: false,
    });
    expect(
      googlePlacesBuildConfiguration({ EAS_BUILD: 'false', NAVOSS_GOOGLE_PLACES_ENABLED: '1' }),
    ).toEqual({ enabled: false });
  });

  it('writes the key whenever it is present, inside or outside the build job', () => {
    expect(
      googlePlacesBuildConfiguration({
        EAS_BUILD: 'true',
        GOOGLE_PLACES_IOS_API_KEY: 'test-restricted-key',
        NAVOSS_GOOGLE_PLACES_ENABLED: '1',
      }),
    ).toEqual({ apiKey: 'test-restricted-key', enabled: true });
  });

  it('passes the trimmed key only to an enabled build', () => {
    expect(
      googlePlacesBuildConfiguration({
        GOOGLE_PLACES_IOS_API_KEY: '  test-restricted-key  ',
        NAVOSS_GOOGLE_PLACES_ENABLED: '1',
      }),
    ).toEqual({ apiKey: 'test-restricted-key', enabled: true });
  });

  it('keeps default production keyless and provides an explicit Google-enabled profile', () => {
    const eas = JSON.parse(readFileSync(resolve(import.meta.dirname, '..', 'eas.json'), 'utf8'));

    expect(eas.build.production.env.NAVOSS_GOOGLE_PLACES_ENABLED).toBe('0');
    expect(eas.build['internal-carplay']).toMatchObject({
      distribution: 'internal',
      environment: 'production',
      env: {
        NAVOSS_CARPLAY_ENABLED: '1',
        NAVOSS_CARPLAY_ENTITLEMENT_ENABLED: '1',
        NAVOSS_GOOGLE_PLACES_ENABLED: '0',
      },
    });
    expect(eas.build['production-carplay'].env.NAVOSS_GOOGLE_PLACES_ENABLED).toBe('0');
    expect(eas.build['production-carplay-google'].env.NAVOSS_GOOGLE_PLACES_ENABLED).toBe('1');
    expect(eas.submit['production-carplay-google'].ios.ascAppId).toBe('6792619727');
  });
});
