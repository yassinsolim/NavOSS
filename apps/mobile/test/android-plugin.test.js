import { describe, expect, it } from 'vitest';

import {
  ARCHITECTURES,
  setGradleProperty,
  withNoCleartextTraffic,
} from '../plugins/with-navoss-android.cjs';

describe('Android config plugin', () => {
  it('replaces the generated architecture list instead of appending a second entry', () => {
    const properties = [
      { type: 'comment', value: 'Use this property to specify which architecture to build.' },
      {
        key: 'reactNativeArchitectures',
        type: 'property',
        value: 'armeabi-v7a,arm64-v8a,x86,x86_64',
      },
    ];
    setGradleProperty(properties, 'reactNativeArchitectures', ARCHITECTURES);
    setGradleProperty(properties, 'reactNativeArchitectures', ARCHITECTURES);
    const entries = properties.filter((item) => item.key === 'reactNativeArchitectures');
    expect(entries).toEqual([
      { key: 'reactNativeArchitectures', type: 'property', value: 'arm64-v8a' },
    ]);
  });

  it('turns cleartext traffic off on the main application', () => {
    const manifest = {
      manifest: {
        $: {},
        application: [{ $: { 'android:name': '.MainApplication' } }],
      },
    };
    const patched = withNoCleartextTraffic(manifest);
    expect(patched.manifest.application[0].$['android:usesCleartextTraffic']).toBe('false');
  });
});
