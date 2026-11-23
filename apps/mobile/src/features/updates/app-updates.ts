import { createValueStore, type ValueStore } from '../../lib/value-store';

import type { InstalledVersion, InstallStatus } from '../../../modules/navoss-updater';
import { checkResultMessage, updateFailureMessage } from './update-copy';
import {
  type AvailableUpdate,
  type CheckCode,
  checkCodeForStatus,
  latestUpdate,
} from './update-feed';
import {
  DEFAULT_UPDATE_PREFERENCES,
  isAutomaticCheckDue,
  isNoticeSnoozed,
  normalizeUpdatePreferences,
  type UpdatePreferences,
} from './update-schedule';

export type UpdatePhase =
  | { kind: 'available'; update: AvailableUpdate }
  | { kind: 'checking' }
  | { kind: 'downloading'; received: number; total: number; update: AvailableUpdate }
  | { kind: 'failed'; message: string; update: AvailableUpdate }
  | { kind: 'idle' }
  /** Verifying the file, then the system's install prompt. */
  | { kind: 'installing'; update: AvailableUpdate }
  | { kind: 'needs-permission'; update: AvailableUpdate }
  /** Downloaded while a trip was active; installs only when the driver taps Install after it. */
  | { kind: 'ready'; update: AvailableUpdate };

export interface AppUpdatesState {
  installed: InstalledVersion | undefined;
  /** The outcome of the last "Check now", shown in settings. */
  lastCheckMessage: string | undefined;
  phase: UpdatePhase;
  preferences: UpdatePreferences;
  /** False until stored preferences have been read. */
  ready: boolean;
}

/** The parts of the native module the controller uses (a fake in tests). */
export interface UpdaterNative {
  addListener(
    event: 'onDownloadProgress',
    listener: (progress: { received: number; total: number }) => void,
  ): { remove: () => void };
  addListener(
    event: 'onInstallStatus',
    listener: (event: { status: InstallStatus }) => void,
  ): { remove: () => void };
  canRequestPackageInstalls(): boolean;
  cancelDownload(): void;
  cleanDownloads(keepVersionCode: number): void;
  download(url: string, size: number, versionCode: number): Promise<void>;
  downloadedBytes(versionCode: number): number;
  getInstalledVersion(): InstalledVersion;
  openInstallPermissionSettings(): void;
  setInstallHold(held: boolean): void;
  verifyAndInstall(versionCode: number, sha256: string): Promise<void>;
}

export interface AppUpdatesDependencies {
  feedUrl: string;
  /** One GET of the releases list. Rejects when there is no network. */
  fetchReleases: (url: string) => Promise<{ json: () => Promise<unknown>; status: number }>;
  /** Receives only a result code. */
  log: (code: CheckCode) => void;
  native: UpdaterNative;
  now: () => number;
  storage: { load: () => Promise<string | null>; save: (value: string) => Promise<void> };
}

function errorCode(error: unknown): string {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    if (typeof error.code === 'string') return error.code;
  }
  return 'failed';
}

export interface AppUpdates {
  /** Read preferences and the installed version; delete downloads nobody needs any more. */
  start: () => Promise<void>;
  /** The once-a-day check on app start or return to the foreground. Never during a trip. */
  checkAutomatically: (tripActive: boolean) => Promise<void>;
  checkNow: () => Promise<void>;
  install: () => Promise<void>;
  cancelDownload: () => void;
  later: () => Promise<void>;
  openInstallPermissionSettings: () => void;
  /** The app came back to the foreground: continue once installs from NavOSS are allowed. */
  resume: () => void;
  setAutoCheck: (value: boolean) => Promise<void>;
  /**
   * The live trip state. While a trip is active nothing is installed and the system's install
   * prompt never opens: a finished download waits as `ready` until the driver taps Install after
   * the trip. The native installer is held too, for an install already on its way.
   */
  setTripActive: (active: boolean) => void;
  /** Whether the notice over the map shows now. */
  isNoticeVisible: (state: AppUpdatesState, tripActive: boolean) => boolean;
  store: ValueStore<AppUpdatesState>;
}

export function createAppUpdates(dependencies: AppUpdatesDependencies): AppUpdates {
  const { native } = dependencies;
  const store = createValueStore<AppUpdatesState>({
    installed: undefined,
    lastCheckMessage: undefined,
    phase: { kind: 'idle' },
    preferences: DEFAULT_UPDATE_PREFERENCES,
    ready: false,
  });
  let checking = false;
  let tripActive = false;

  const update = (patch: Partial<AppUpdatesState>) => {
    store.set({ ...store.get(), ...patch });
  };
  const setPhase = (phase: UpdatePhase) => {
    update({ phase });
  };
  const savePreferences = async (patch: Partial<UpdatePreferences>) => {
    const preferences = { ...store.get().preferences, ...patch };
    update({ preferences });
    try {
      await dependencies.storage.save(JSON.stringify(preferences));
    } catch {
      // Preferences stay in memory for this session.
    }
  };
  const currentUpdate = (): AvailableUpdate | undefined => {
    const { phase } = store.get();
    return 'update' in phase ? phase.update : undefined;
  };
  const busy = () => {
    const { kind } = store.get().phase;
    return kind === 'downloading' || kind === 'installing';
  };

  native.addListener('onDownloadProgress', ({ received, total }) => {
    const { phase } = store.get();
    if (phase.kind === 'downloading') setPhase({ ...phase, received, total });
  });
  native.addListener('onInstallStatus', ({ status }) => {
    const { phase } = store.get();
    if (phase.kind !== 'installing') return;
    if (status === 'pending-user-action' || status === 'success') return;
    if (status === 'deferred') {
      setPhase({ kind: 'ready', update: phase.update });
      return;
    }
    if (status === 'cancelled') {
      setPhase({ kind: 'available', update: phase.update });
      return;
    }
    setPhase({ kind: 'failed', message: updateFailureMessage(status), update: phase.update });
  });

  async function check(manual: boolean): Promise<void> {
    const installed = store.get().installed;
    if (checking || busy() || installed === undefined) return;
    checking = true;
    if (manual) update({ lastCheckMessage: undefined, phase: { kind: 'checking' } });
    await savePreferences({ lastCheckAt: dependencies.now() });
    let code: CheckCode;
    let found: AvailableUpdate | undefined;
    try {
      const response = await dependencies.fetchReleases(dependencies.feedUrl);
      const statusCode = checkCodeForStatus(response.status);
      if (statusCode !== undefined) {
        code = statusCode;
      } else {
        let json: unknown;
        try {
          json = await response.json();
        } catch {
          json = undefined;
        }
        const result = latestUpdate(json, installed.versionCode, dependencies.feedUrl);
        code = result.kind;
        if (result.kind === 'update') found = result.update;
      }
    } catch {
      code = 'no-network';
    }
    checking = false;
    dependencies.log(code);
    if (found !== undefined) {
      if (found.versionCode !== store.get().preferences.offeredVersionCode) {
        native.cleanDownloads(found.versionCode);
        await savePreferences({ offeredVersionCode: found.versionCode });
      }
      const { phase } = store.get();
      const sameVersion = 'update' in phase && phase.update.versionCode === found.versionCode;
      // A running download or install keeps the release it started with. A failure or a
      // permission request for the same version stays, but retries the release as published now.
      if (!busy()) {
        setPhase(
          sameVersion &&
            (phase.kind === 'failed' || phase.kind === 'needs-permission' || phase.kind === 'ready')
            ? { ...phase, update: found }
            : { kind: 'available', update: found },
        );
      }
    } else if (store.get().phase.kind === 'checking' || store.get().phase.kind === 'available') {
      setPhase({ kind: 'idle' });
    }
    // An offer shows its own card; the message is for every other outcome.
    if (manual)
      update({ lastCheckMessage: code === 'update' ? undefined : checkResultMessage(code) });
  }

  async function downloadAndInstall(target: AvailableUpdate): Promise<void> {
    if (!native.canRequestPackageInstalls()) {
      setPhase({ kind: 'needs-permission', update: target });
      return;
    }
    setPhase({
      kind: 'downloading',
      received: native.downloadedBytes(target.versionCode),
      total: target.sizeBytes,
      update: target,
    });
    try {
      await native.download(target.apkUrl, target.sizeBytes, target.versionCode);
    } catch (error) {
      const code = errorCode(error);
      setPhase(
        code === 'cancelled'
          ? { kind: 'available', update: target }
          : { kind: 'failed', message: updateFailureMessage(code), update: target },
      );
      return;
    }
    // Read the trip state now, when the download has finished: it may have started meanwhile.
    if (tripActive) {
      setPhase({ kind: 'ready', update: target });
      return;
    }
    setPhase({ kind: 'installing', update: target });
    try {
      await native.verifyAndInstall(target.versionCode, target.sha256);
    } catch (error) {
      const code = errorCode(error);
      setPhase(
        code === 'deferred'
          ? { kind: 'ready', update: target }
          : { kind: 'failed', message: updateFailureMessage(code), update: target },
      );
    }
  }

  return {
    store,
    start: async () => {
      if (store.get().ready) return;
      let preferences: UpdatePreferences;
      try {
        const stored = await dependencies.storage.load();
        preferences = normalizeUpdatePreferences(stored === null ? null : JSON.parse(stored));
      } catch {
        preferences = DEFAULT_UPDATE_PREFERENCES;
      }
      const installed = native.getInstalledVersion();
      const offered = preferences.offeredVersionCode;
      // Keep a partial download of a still-newer version so it can resume; delete the rest.
      native.cleanDownloads(offered !== undefined && offered > installed.versionCode ? offered : 0);
      update({ installed, preferences, ready: true });
    },
    checkAutomatically: async (tripActive) => {
      const { preferences, ready } = store.get();
      if (!ready || !isAutomaticCheckDue(preferences, dependencies.now(), tripActive)) return;
      await check(false);
    },
    checkNow: () => check(true),
    install: async () => {
      const target = currentUpdate();
      if (target === undefined || busy()) return;
      await downloadAndInstall(target);
    },
    cancelDownload: () => {
      if (store.get().phase.kind === 'downloading') native.cancelDownload();
    },
    later: async () => {
      const target = currentUpdate();
      if (target === undefined) return;
      if (store.get().phase.kind === 'downloading') native.cancelDownload();
      setPhase({ kind: 'available', update: target });
      await savePreferences({
        dismissedAt: dependencies.now(),
        dismissedVersionCode: target.versionCode,
      });
    },
    openInstallPermissionSettings: () => {
      native.openInstallPermissionSettings();
    },
    resume: () => {
      const { phase } = store.get();
      if (phase.kind === 'needs-permission' && native.canRequestPackageInstalls()) {
        void downloadAndInstall(phase.update);
      }
    },
    setAutoCheck: (value) => savePreferences({ autoCheck: value }),
    setTripActive: (active) => {
      if (active === tripActive) return;
      tripActive = active;
      native.setInstallHold(active);
    },
    isNoticeVisible: (state, tripActive) => {
      if (tripActive) return false;
      const { phase } = state;
      if (phase.kind === 'idle' || phase.kind === 'checking') return false;
      if (phase.kind !== 'available') return true;
      return !isNoticeSnoozed(state.preferences, phase.update.versionCode, dependencies.now());
    },
  };
}
