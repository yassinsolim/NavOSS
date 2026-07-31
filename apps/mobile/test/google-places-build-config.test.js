import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const {
  googlePlacesBuildConfiguration,
  sourceFiles,
} = require('../plugins/with-navoss-carplay.cjs');

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

  it('keeps default production keyless and provides an explicit Google-enabled profile', () => {
    const eas = JSON.parse(readFileSync(resolve(import.meta.dirname, '..', 'eas.json'), 'utf8'));

    expect(eas.build.production.env.NAVOSS_GOOGLE_PLACES_ENABLED).toBe('0');
    expect(eas.build['production-carplay'].env.NAVOSS_GOOGLE_PLACES_ENABLED).toBe('0');
    expect(eas.build['production-carplay-google'].env.NAVOSS_GOOGLE_PLACES_ENABLED).toBe('1');
    expect(eas.submit['production-carplay-google'].ios.ascAppId).toBe('6792619727');
  });

  it('renders photos, rating count, and reviews in the standard Google place details view', () => {
    const nativeView = readFileSync(
      resolve(
        import.meta.dirname,
        '..',
        'modules/navoss-navigation/ios/NavOSSGooglePlaceRatingView.swift',
      ),
      'utf8',
    );

    expect(nativeView).toContain('GooglePlacesSwift.PlaceDetailsView(');
    expect(nativeView).toContain('content: [.media(), .rating(), .reviews()]');
    expect(nativeView).not.toContain('AdvancedPlaceDetailsView(');
  });

  it('packages the visual host behind simulator compiler guards', () => {
    expect(sourceFiles).toContain('NavOSSCarPlayVisualHarnessViewController.swift');

    const visualHarness = readFileSync(
      resolve(
        import.meta.dirname,
        '..',
        'carplay/ios/NavOSSCarPlayVisualHarnessViewController.swift',
      ),
      'utf8',
    );
    const phoneScene = readFileSync(
      resolve(import.meta.dirname, '..', 'carplay/ios/NavOSSPhoneSceneDelegate.swift'),
      'utf8',
    );

    expect(visualHarness).toContain('#if targetEnvironment(simulator)');
    expect(phoneScene).toContain('#if targetEnvironment(simulator)');
    expect(phoneScene).toContain('NAVOSS_CARPLAY_VISUAL_SCENARIO');
  });
});
