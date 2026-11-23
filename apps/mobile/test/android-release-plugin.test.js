import { describe, expect, it } from 'vitest';

import {
  addReleaseSigning,
  resolveVersionCode,
  setVersion,
  testFeedOrigin,
} from '../plugins/with-navoss-android-release.cjs';

const GRADLE = `android {
    defaultConfig {
        versionCode 1
        versionName "0.1.0"
    }
}
`;

describe('Android release config plugin', () => {
  it('takes the version code from the build environment, else app.json', () => {
    expect(resolveVersionCode({}, 1)).toBe(1);
    expect(resolveVersionCode({ NAVOSS_ANDROID_VERSION_CODE: '142' }, 1)).toBe(142);
    for (const bad of ['0', '-3', '1.5', 'abc', '2100000001']) {
      expect(() => resolveVersionCode({ NAVOSS_ANDROID_VERSION_CODE: bad }, 1)).toThrow();
    }
  });

  it('writes the version into defaultConfig', () => {
    const gradle = setVersion(GRADLE, 142, '0.2.0');
    expect(gradle).toContain('versionCode 142');
    expect(gradle).toContain('versionName "0.2.0"');
    expect(() => setVersion('android {}', 1, '0.1.0')).toThrow();
  });

  it('adds the signing block once and keeps secrets out of the generated file', () => {
    const once = addReleaseSigning(GRADLE);
    const twice = addReleaseSigning(once);
    expect(twice).toBe(once);
    expect(once.match(/navoss-release-signing/g)).toHaveLength(2);
    expect(once).toContain("System.getenv('NAVOSS_ANDROID_KEYSTORE_PASSWORD')");
    expect(once).toContain('signingConfig signingConfigs.navossRelease');
    expect(once).toContain('throw new GradleException');
  });

  it('accepts a test feed on 127.0.0.1 only and allows cleartext for it alone', () => {
    expect(testFeedOrigin({})).toBeUndefined();
    // The updater refuses any other host, so a build pointing elsewhere fails here instead.
    for (const url of ['https://example.org/x', 'http://localhost:8765/releases']) {
      expect(() => testFeedOrigin({ EXPO_PUBLIC_NAVOSS_UPDATE_FEED_URL: url })).toThrow();
    }
    expect(
      testFeedOrigin({ EXPO_PUBLIC_NAVOSS_UPDATE_FEED_URL: 'http://127.0.0.1:8765/releases' }),
    ).toBe('127.0.0.1');
    expect(() =>
      testFeedOrigin({ EXPO_PUBLIC_NAVOSS_UPDATE_FEED_URL: 'http://192.168.1.5/releases' }),
    ).toThrow();
  });
});
