import { describe, expect, it } from 'vitest';

import {
  PERMISSIONS,
  SERVICE_NAME,
  withNavigationPermissions,
  withNavigationService,
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
          'android:foregroundServiceType': 'location',
          'android:name': SERVICE_NAME,
        },
      },
    ]);
  });

  it('adds each permission once and never background location', () => {
    const patched = withNavigationPermissions(withNavigationPermissions(manifest()));
    const names = patched.manifest['uses-permission'].map((item) => item.$['android:name']);
    expect(names.toSorted()).toEqual(PERMISSIONS.toSorted());
    expect(names).not.toContain('android.permission.ACCESS_BACKGROUND_LOCATION');
  });
});
