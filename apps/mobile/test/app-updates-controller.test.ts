import { describe, expect, it } from 'vitest';

import {
  type AppUpdatesDependencies,
  createAppUpdates,
  type UpdaterNative,
} from '../src/features/updates/app-updates.js';
import { RELEASES_URL } from '../src/features/updates/update-feed.js';

const TAG = 'android-v0.2.0-102';
const RELEASES = [
  {
    assets: [
      {
        browser_download_url: `https://github.com/yassinsolim/NavOSS/releases/download/${TAG}/navoss.apk`,
        digest: 'sha256:' + 'ab'.repeat(32),
        name: 'navoss.apk',
        size: 40_000_000,
        state: 'uploaded',
      },
    ],
    draft: false,
    prerelease: false,
    tag_name: TAG,
  },
];

function harness({
  allowed = true,
  downloadError,
  holdDownload = false,
  installError,
  response = { body: RELEASES as unknown, status: 200 },
  stored = null as string | null,
}: {
  allowed?: boolean;
  downloadError?: string;
  /** The first download resolves only when the test calls `finishDownload`. */
  holdDownload?: boolean;
  installError?: string;
  response?: { body: unknown; status: number } | 'offline';
  stored?: string | null;
} = {}) {
  let now = 1_800_000_000_000;
  const requests: string[] = [];
  const logs: string[] = [];
  const calls: string[] = [];
  const listeners: Record<string, (payload: never) => void> = {};
  let saved = stored;
  let finishDownload: () => void = () => undefined;
  const native = {
    addListener: (event: string, listener: (payload: never) => void) => {
      listeners[event] = listener;
      return { remove: () => undefined };
    },
    canRequestPackageInstalls: () => allowed,
    cancelDownload: () => calls.push('cancel'),
    cleanDownloads: (keep: number) => calls.push(`clean:${String(keep)}`),
    download: (_url: string, size: number, versionCode: number) => {
      calls.push(`download:${String(versionCode)}:${String(size)}`);
      if (holdDownload) {
        holdDownload = false;
        return new Promise<void>((resolve) => {
          finishDownload = resolve;
        });
      }
      return downloadError === undefined
        ? Promise.resolve()
        : Promise.reject(Object.assign(new Error('x'), { code: downloadError }));
    },
    downloadedBytes: () => 0,
    getInstalledVersion: () => ({
      sdkInt: 33,
      signedByRelease: true,
      versionCode: 101,
      versionName: '0.1.0',
    }),
    openInstallPermissionSettings: () => calls.push('settings'),
    setInstallHold: (held: boolean) => calls.push(`hold:${String(held)}`),
    verifyAndInstall: (versionCode: number, sha256: string) => {
      calls.push(`install:${String(versionCode)}:${sha256.slice(0, 4)}`);
      return installError === undefined
        ? Promise.resolve()
        : Promise.reject(Object.assign(new Error('x'), { code: installError }));
    },
  } as unknown as UpdaterNative;
  const dependencies: AppUpdatesDependencies = {
    feedUrl: RELEASES_URL,
    fetchReleases: (url) => {
      requests.push(url);
      const current = response;
      if (current === 'offline') return Promise.reject(new TypeError('Network request failed'));
      return Promise.resolve({
        json: () => Promise.resolve(current.body),
        status: current.status,
      });
    },
    log: (code) => logs.push(code),
    native,
    now: () => now,
    storage: {
      load: () => Promise.resolve(saved),
      save: (value) => {
        saved = value;
        return Promise.resolve();
      },
    },
  };
  const updater = createAppUpdates(dependencies);
  return {
    advance: (ms: number) => {
      now += ms;
    },
    calls,
    finishDownload: async () => {
      finishDownload();
      await new Promise((resolve) => setTimeout(resolve, 0));
    },
    grant: () => {
      allowed = true;
    },
    republish: (body: unknown) => {
      response = { body, status: 200 };
    },
    emitInstall: (status: string) => listeners.onInstallStatus({ status } as never),
    logs,
    requests,
    saved: () => saved,
    updater,
  };
}

describe('app updates', () => {
  it('checks once on start, offers the update and does not check again the same day', async () => {
    const h = harness();
    await h.updater.start();
    await h.updater.checkAutomatically(false);
    await h.updater.checkAutomatically(false);
    expect(h.requests).toEqual([RELEASES_URL]);
    expect(h.logs).toEqual(['update']);
    const state = h.updater.store.get();
    expect(state.phase.kind).toBe('available');
    expect(h.updater.isNoticeVisible(state, false)).toBe(true);
    // Never shown during a trip.
    expect(h.updater.isNoticeVisible(state, true)).toBe(false);
  });

  it('sends no request during a trip or when switched off', async () => {
    const trip = harness();
    await trip.updater.start();
    await trip.updater.checkAutomatically(true);
    expect(trip.requests).toEqual([]);

    const off = harness({ stored: JSON.stringify({ autoCheck: false }) });
    await off.updater.start();
    await off.updater.checkAutomatically(false);
    expect(off.requests).toEqual([]);
    // "Check now" still works with the switch off.
    await off.updater.checkNow();
    expect(off.requests).toEqual([RELEASES_URL]);
  });

  it('stays quiet when an automatic check fails, and explains a manual one', async () => {
    for (const response of [
      'offline',
      { body: {}, status: 403 },
      { body: 'x', status: 200 },
    ] as const) {
      const h = harness({ response });
      await h.updater.start();
      await h.updater.checkAutomatically(false);
      expect(h.updater.store.get().phase.kind).toBe('idle');
      expect(h.updater.store.get().lastCheckMessage).toBeUndefined();
      await h.updater.checkNow();
      expect(h.updater.store.get().lastCheckMessage).not.toBe('NavOSS is up to date.');
      expect(h.updater.store.get().lastCheckMessage).toBeDefined();
    }
  });

  it('"Later" hides the notice until the next day', async () => {
    const h = harness();
    await h.updater.start();
    await h.updater.checkAutomatically(false);
    await h.updater.later();
    expect(h.updater.isNoticeVisible(h.updater.store.get(), false)).toBe(false);
    h.advance(24 * 60 * 60 * 1000);
    expect(h.updater.isNoticeVisible(h.updater.store.get(), false)).toBe(true);
  });

  it('downloads, then verifies and installs with the published digest', async () => {
    const h = harness();
    await h.updater.start();
    await h.updater.checkAutomatically(false);
    await h.updater.install();
    expect(h.calls).toContain('download:102:40000000');
    expect(h.calls).toContain('install:102:ABAB');
    expect(h.updater.store.get().phase.kind).toBe('installing');
    h.emitInstall('cancelled');
    expect(h.updater.store.get().phase.kind).toBe('available');
  });

  it('asks for the install permission first and continues once it is granted', async () => {
    const h = harness({ allowed: false });
    await h.updater.start();
    await h.updater.checkAutomatically(false);
    await h.updater.install();
    expect(h.updater.store.get().phase.kind).toBe('needs-permission');
    expect(h.calls.some((call) => call.startsWith('download'))).toBe(false);
  });

  it('turns a rejected download into a plain message', async () => {
    const h = harness({ installError: 'wrong-signer' });
    await h.updater.start();
    await h.updater.checkAutomatically(false);
    await h.updater.install();
    const { phase } = h.updater.store.get();
    expect(phase.kind).toBe('failed');
    expect(phase.kind === 'failed' && phase.message).toBe(
      'This file isn’t signed by NavOSS, so it was deleted and not installed.',
    );
  });

  it('keeps a stopped download resumable and shows the network message', async () => {
    const h = harness({ downloadError: 'network' });
    await h.updater.start();
    await h.updater.checkAutomatically(false);
    await h.updater.install();
    const { phase } = h.updater.store.get();
    expect(phase.kind === 'failed' && phase.message).toContain('continues where it stopped');
    expect(h.calls.filter((call) => call.startsWith('clean'))).toEqual(['clean:0', 'clean:102']);
  });

  it('says a full disk is a storage problem, not a connection one', async () => {
    const h = harness({ downloadError: 'storage' });
    await h.updater.start();
    await h.updater.checkAutomatically(false);
    await h.updater.install();
    const { phase } = h.updater.store.get();
    expect(phase.kind === 'failed' && phase.message).toBe(
      'There isn’t enough free storage for the update. Free up some space and try again.',
    );
  });

  it('keeps the partial download of an offered newer version across a restart', async () => {
    const h = harness({ stored: JSON.stringify({ autoCheck: true, offeredVersionCode: 102 }) });
    await h.updater.start();
    expect(h.calls).toEqual(['clean:102']);
    const old = harness({ stored: JSON.stringify({ autoCheck: true, offeredVersionCode: 101 }) });
    await old.updater.start();
    expect(old.calls).toEqual(['clean:0']);
  });

  it('retries a failed version with the digest the release publishes now', async () => {
    const h = harness({ installError: 'digest-mismatch' });
    await h.updater.start();
    await h.updater.checkAutomatically(false);
    await h.updater.install();
    expect(h.updater.store.get().phase.kind).toBe('failed');
    const fixed = structuredClone(RELEASES);
    fixed[0].assets[0].digest = 'sha256:' + 'cd'.repeat(32);
    h.republish(fixed);
    h.advance(24 * 60 * 60 * 1000);
    await h.updater.checkAutomatically(false);
    const { phase } = h.updater.store.get();
    expect(phase.kind).toBe('failed');
    expect('update' in phase && phase.update.sha256).toBe('CD'.repeat(32));
  });

  it('keeps a download that finishes during a trip and offers it only after the trip', async () => {
    const h = harness({ holdDownload: true });
    await h.updater.start();
    await h.updater.checkAutomatically(false);
    const installing = h.updater.install();
    expect(h.updater.store.get().phase.kind).toBe('downloading');
    // A trip starts while the download runs; the native installer is held at once.
    h.updater.setTripActive(true);
    expect(h.calls).toContain('hold:true');
    await h.finishDownload();
    await installing;
    expect(h.calls.some((call) => call.startsWith('install:'))).toBe(false);
    const state = h.updater.store.get();
    expect(state.phase.kind).toBe('ready');
    expect(h.updater.isNoticeVisible(state, true)).toBe(false);
    // After End the notice comes back; nothing opens the system prompt on its own.
    h.updater.setTripActive(false);
    expect(h.calls).toContain('hold:false');
    expect(h.updater.isNoticeVisible(h.updater.store.get(), false)).toBe(true);
    expect(h.calls.some((call) => call.startsWith('install:'))).toBe(false);
    await h.updater.install();
    expect(h.calls).toContain('install:102:ABAB');
  });

  it('does not install on return from the permission screen during a trip', async () => {
    const h = harness({ allowed: false });
    await h.updater.start();
    await h.updater.checkAutomatically(false);
    await h.updater.install();
    expect(h.updater.store.get().phase.kind).toBe('needs-permission');
    h.updater.setTripActive(true);
    h.grant();
    h.updater.resume();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(h.calls).toContain('download:102:40000000');
    expect(h.calls.some((call) => call.startsWith('install:'))).toBe(false);
    expect(h.updater.store.get().phase.kind).toBe('ready');
  });

  it('returns to "ready" when the installer defers its prompt because a trip started', async () => {
    const h = harness();
    await h.updater.start();
    await h.updater.checkAutomatically(false);
    await h.updater.install();
    expect(h.updater.store.get().phase.kind).toBe('installing');
    h.emitInstall('deferred');
    expect(h.updater.store.get().phase.kind).toBe('ready');
    const rejected = harness({ installError: 'deferred' });
    await rejected.updater.start();
    await rejected.updater.checkAutomatically(false);
    await rejected.updater.install();
    expect(rejected.updater.store.get().phase.kind).toBe('ready');
  });
});
