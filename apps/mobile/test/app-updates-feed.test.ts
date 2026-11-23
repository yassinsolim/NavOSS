import { describe, expect, it } from 'vitest';

import {
  checkCodeForStatus,
  isAllowedDownloadUrl,
  latestUpdate,
  parseReleaseTag,
  RELEASES_URL,
} from '../src/features/updates/update-feed.js';
import {
  CHECK_INTERVAL_MS,
  isAutomaticCheckDue,
  isNoticeSnoozed,
  normalizeUpdatePreferences,
} from '../src/features/updates/update-schedule.js';
import { formatMegabytes, updateFailureMessage } from '../src/features/updates/update-copy.js';

const DIGEST = 'sha256:' + 'ab'.repeat(32);

function release(
  tag: string,
  overrides: Record<string, unknown> = {},
  asset: Record<string, unknown> = {},
) {
  return {
    assets: [
      {
        browser_download_url: `https://github.com/yassinsolim/NavOSS/releases/download/${tag}/${tag}.apk.sha256`,
        digest: 'sha256:' + 'cd'.repeat(32),
        name: `${tag}.apk.sha256`,
        size: 90,
        state: 'uploaded',
      },
      {
        browser_download_url: `https://github.com/yassinsolim/NavOSS/releases/download/${tag}/navoss.apk`,
        digest: DIGEST,
        name: 'navoss.apk',
        size: 48_000_000,
        state: 'uploaded',
        ...asset,
      },
    ],
    draft: false,
    prerelease: false,
    tag_name: tag,
    ...overrides,
  };
}

describe('release feed', () => {
  it('reads the version name and code from the tag', () => {
    expect(parseReleaseTag('android-v0.2.0-142')).toEqual({
      versionCode: 142,
      versionName: '0.2.0',
    });
    expect(parseReleaseTag('ios-v0.2.0')).toBeUndefined();
    expect(parseReleaseTag('android-v0.2.0')).toBeUndefined();
    expect(parseReleaseTag('android-v0.2.0-0')).toBeUndefined();
  });

  it('offers the highest version code among Android releases, ignoring iOS releases', () => {
    const result = latestUpdate(
      [release('ios-v0.3.0'), release('android-v0.2.0-141'), release('android-v0.2.1-143')],
      101,
    );
    expect(result).toEqual({
      kind: 'update',
      update: {
        apkName: 'navoss.apk',
        apkUrl:
          'https://github.com/yassinsolim/NavOSS/releases/download/android-v0.2.1-143/navoss.apk',
        sha256: 'AB'.repeat(32),
        sizeBytes: 48_000_000,
        tag: 'android-v0.2.1-143',
        versionCode: 143,
        versionName: '0.2.1',
      },
    });
  });

  it('compares version codes only', () => {
    expect(latestUpdate([release('android-v9.9.9-101')], 101)).toEqual({
      kind: 'up-to-date',
      latestVersionCode: 101,
    });
    expect(latestUpdate([release('android-v0.0.1-102')], 101).kind).toBe('update');
  });

  it('skips drafts, pre-releases and releases without a verifiable APK', () => {
    const skipped = [
      release('android-v0.2.0-150', { draft: true }),
      release('android-v0.2.0-151', { prerelease: true }),
      release('android-v0.2.0-152', {}, { digest: undefined }),
      release('android-v0.2.0-153', {}, { digest: 'md5:abc' }),
      release('android-v0.2.0-154', {}, { size: 0 }),
      release('android-v0.2.0-155', {}, { state: 'starter' }),
      release(
        'android-v0.2.0-156',
        {},
        { browser_download_url: 'https://evil.example/navoss.apk' },
      ),
      release(
        'android-v0.2.0-157',
        {},
        {
          browser_download_url:
            'http://github.com/yassinsolim/NavOSS/releases/download/x/navoss.apk',
        },
      ),
      release(
        'android-v0.2.0-158',
        {},
        {
          browser_download_url: 'https://github.com/someone/fork/releases/download/x/navoss.apk',
        },
      ),
      release('android-v0.2.0-159', { assets: [] }),
    ];
    expect(latestUpdate(skipped, 101)).toEqual({ kind: 'no-release' });
    expect(latestUpdate([...skipped, release('android-v0.2.0-110')], 101).kind).toBe('update');
  });

  it('treats a body that is not a release list as malformed', () => {
    expect(latestUpdate({ message: 'Not Found' }, 101)).toEqual({ kind: 'malformed' });
    expect(latestUpdate(undefined, 101)).toEqual({ kind: 'malformed' });
    expect(latestUpdate([null, 3, 'x'], 101)).toEqual({ kind: 'no-release' });
  });

  it('maps rate limiting and server errors to quiet codes', () => {
    expect(checkCodeForStatus(200)).toBeUndefined();
    expect(checkCodeForStatus(403)).toBe('rate-limited');
    expect(checkCodeForStatus(429)).toBe('rate-limited');
    expect(checkCodeForStatus(502)).toBe('unavailable');
  });

  it('accepts a local test feed only for that feed’s own origin', () => {
    const feed = 'http://127.0.0.1:8765/releases';
    expect(isAllowedDownloadUrl('http://127.0.0.1:8765/navoss.apk', feed)).toBe(true);
    expect(isAllowedDownloadUrl('http://127.0.0.1:8765/navoss.apk', RELEASES_URL)).toBe(false);
    expect(isAllowedDownloadUrl('http://127.0.0.1:9999/navoss.apk', feed)).toBe(false);
  });
});

describe('update schedule', () => {
  const now = 1_800_000_000_000;

  it('checks at most once a day, only when switched on and never during a trip', () => {
    expect(isAutomaticCheckDue({ autoCheck: true }, now, false)).toBe(true);
    expect(isAutomaticCheckDue({ autoCheck: true }, now, true)).toBe(false);
    expect(isAutomaticCheckDue({ autoCheck: false }, now, false)).toBe(false);
    expect(isAutomaticCheckDue({ autoCheck: true, lastCheckAt: now - 1000 }, now, false)).toBe(
      false,
    );
    expect(
      isAutomaticCheckDue({ autoCheck: true, lastCheckAt: now - CHECK_INTERVAL_MS }, now, false),
    ).toBe(true);
    // The clock was set back: do not wait for a date that may be years away.
    expect(isAutomaticCheckDue({ autoCheck: true, lastCheckAt: now + 1000 }, now, false)).toBe(
      true,
    );
  });

  it('"Later" hides a version until the next day, and never hides a newer one', () => {
    const preferences = { autoCheck: true, dismissedAt: now - 1000, dismissedVersionCode: 142 };
    expect(isNoticeSnoozed(preferences, 142, now)).toBe(true);
    expect(isNoticeSnoozed(preferences, 143, now)).toBe(false);
    expect(isNoticeSnoozed(preferences, 142, now - 1000 + CHECK_INTERVAL_MS)).toBe(false);
  });

  it('reads damaged stored preferences as the defaults', () => {
    expect(normalizeUpdatePreferences('x')).toEqual({ autoCheck: true });
    expect(normalizeUpdatePreferences({ autoCheck: 'no', lastCheckAt: 'yesterday' })).toEqual({
      autoCheck: true,
      dismissedAt: undefined,
      dismissedVersionCode: undefined,
      lastCheckAt: undefined,
      offeredVersionCode: undefined,
    });
    expect(normalizeUpdatePreferences({ autoCheck: false }).autoCheck).toBe(false);
  });
});

describe('update copy', () => {
  it('states sizes in decimal megabytes', () => {
    expect(formatMegabytes(48_400_000)).toBe('48 MB');
    expect(formatMegabytes(900_000)).toBe('0.9 MB');
  });

  it('never shows a raw failure code', () => {
    for (const code of ['wrong-signer', 'digest-mismatch', 'not-newer', 'network', 'x-unknown']) {
      expect(updateFailureMessage(code)).not.toContain(code);
    }
  });
});
