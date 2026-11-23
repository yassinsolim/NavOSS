import { describe, expect, it } from 'vitest';

import {
  API_URL_META_DATA,
  PERMISSIONS,
  SERVICE_NAME,
  configuredApiUrl,
  withApiUrl,
  withLibcxxReplacement,
  withNavigationPermissions,
  withNavigationService,
  withTextToSpeechQuery,
} from '../plugins/with-navoss-android-navigation.cjs';

function manifest() {
  return {
    manifest: {
      $: {},
      application: [{ $: { 'android:name': '.MainApplication' } }],
      'uses-permission': [{ $: { 'android:name': 'android.permission.ACCESS_FINE_LOCATION' } }],
    },
  };
}

describe('Android navigation config plugin', () => {
  it('declares the location foreground service once, unexported', () => {
    const patched = withNavigationService(withNavigationService(manifest()));
    expect(patched.manifest.application[0].service).toEqual([
      {
        $: {
          'android:exported': 'false',
          'android:foregroundServiceType': 'location|specialUse',
          'android:name': SERVICE_NAME,
        },
        property: [
          {
            $: {
              'android:name': 'android.app.PROPERTY_SPECIAL_USE_FGS_SUBTYPE',
              'android:value': expect.stringContaining('simulated drive'),
            },
          },
        ],
      },
    ]);
  });

  it('adds each permission once and never background location', () => {
    const patched = withNavigationPermissions(withNavigationPermissions(manifest()));
    const names = patched.manifest['uses-permission'].map((item) => item.$['android:name']);
    expect(names.toSorted()).toEqual(PERMISSIONS.toSorted());
    expect(names).not.toContain('android.permission.ACCESS_BACKGROUND_LOCATION');
  });

  it('appends the libc++ replacement to app/build.gradle once', () => {
    const once = withLibcxxReplacement('android {\n}\n');
    expect(withLibcxxReplacement(once)).toBe(once);
    expect(once.startsWith('android {\n}\n')).toBe(true);
    expect(once.split('package NDK r30 libc++_shared.so').length).toBe(2);
  });

  it('writes the API origin the JS bundle uses into the manifest once', () => {
    const patched = withApiUrl(withApiUrl(manifest(), 'https://a.example/'), 'https://b.example/');
    expect(patched.manifest.application[0]['meta-data']).toEqual([
      { $: { 'android:name': API_URL_META_DATA, 'android:value': 'https://b.example/' } },
    ]);
  });

  it('requires an HTTPS API URL outside local development', () => {
    expect(() => configuredApiUrl({})).toThrow('EXPO_PUBLIC_API_URL is required');
    expect(() => configuredApiUrl({ EXPO_PUBLIC_API_URL: 'http://navoss.example' })).toThrow(
      'HTTPS',
    );
    expect(configuredApiUrl({ EXPO_PUBLIC_API_URL: ' https://navoss.example ' })).toBe(
      'https://navoss.example/',
    );
    expect(configuredApiUrl({ EXPO_PUBLIC_API_URL: 'http://10.0.2.2:3001' })).toBe(
      'http://10.0.2.2:3001/',
    );
  });

  it('lets Android 11+ see the installed text-to-speech engines', () => {
    const patched = withTextToSpeechQuery(withTextToSpeechQuery(manifest()));
    expect(patched.manifest.queries).toEqual([
      { intent: [{ action: [{ $: { 'android:name': 'android.intent.action.TTS_SERVICE' } }] }] },
    ]);
  });
});
