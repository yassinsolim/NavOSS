import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const { googlePlacesBuildConfiguration } = require('../plugins/with-navoss-carplay.cjs');

describe('Google Places build configuration', () => {
  it('is disabled and keyless by default', () => {
    expect(googlePlacesBuildConfiguration({})).toEqual({ enabled: false });
  });

  it('fails closed when enabled without a key', () => {
    expect(() => googlePlacesBuildConfiguration({ NAVOSS_GOOGLE_PLACES_ENABLED: '1' })).toThrow(
      'GOOGLE_PLACES_IOS_API_KEY is required',
    );
  });

  it('passes the trimmed key only to an enabled build', () => {
    expect(
      googlePlacesBuildConfiguration({
        GOOGLE_PLACES_IOS_API_KEY: '  test-restricted-key  ',
        NAVOSS_GOOGLE_PLACES_ENABLED: '1',
      }),
    ).toEqual({ apiKey: 'test-restricted-key', enabled: true });
  });
});
