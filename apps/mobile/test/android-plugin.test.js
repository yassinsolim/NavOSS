import { describe, expect, it } from 'vitest';

import {
  ARCHITECTURES,
  setGradleProperty,
  withFreeRotation,
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

  it('lets the main activity rotate and handle the rotation without being recreated', () => {
    const manifest = {
      manifest: {
        $: {},
        application: [
          {
            $: { 'android:name': '.MainApplication' },
            activity: [
              {
                $: {
                  'android:configChanges': 'keyboard|keyboardHidden|orientation|screenSize|uiMode',
                  'android:name': '.MainActivity',
                  'android:screenOrientation': 'portrait',
                },
                'intent-filter': [
                  {
                    action: [{ $: { 'android:name': 'android.intent.action.MAIN' } }],
                    category: [{ $: { 'android:name': 'android.intent.category.LAUNCHER' } }],
                  },
                ],
              },
            ],
          },
        ],
      },
    };
    const activity = withFreeRotation(manifest).manifest.application[0].activity[0].$;
    expect(activity['android:screenOrientation']).toBe('fullUser');
    expect(activity['android:configChanges'].split('|').sort()).toEqual([
      'keyboard',
      'keyboardHidden',
      'orientation',
      'screenLayout',
      'screenSize',
      'smallestScreenSize',
      'uiMode',
    ]);
  });
});
