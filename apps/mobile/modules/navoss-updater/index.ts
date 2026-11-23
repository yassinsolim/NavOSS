import { NativeModule, requireOptionalNativeModule } from 'expo';

export interface InstalledVersion {
  sdkInt: number;
  signedByRelease: boolean;
  versionCode: number;
  versionName: string;
}

/**
 * The installer's result. `pending-user-action` means the system prompt is showing; the app is
 * replaced (and closed) on `success`.
 */
export type InstallStatus =
  | 'blocked'
  | 'cancelled'
  | 'conflict'
  /** A trip was active when the prompt would have opened; the session was abandoned. */
  | 'deferred'
  | 'failed'
  | 'incompatible'
  | 'invalid'
  | 'pending-user-action'
  | 'storage'
  | 'success';

// A type alias, not an interface, so it satisfies Expo's `EventsMap` index signature.
type NavOSSUpdaterEvents = {
  onDownloadProgress: (progress: { received: number; total: number }) => void;
  onInstallStatus: (event: { status: InstallStatus }) => void;
};

declare class NavOSSUpdaterModule extends NativeModule<NavOSSUpdaterEvents> {
  canRequestPackageInstalls(): boolean;
  cancelDownload(): void;
  cleanDownloads(keepVersionCode: number): void;
  /** Rejects with a code: `network`, `http`, `size`, `cancelled`, `storage`, `invalid`, `busy`. */
  download(url: string, size: number, versionCode: number): Promise<void>;
  downloadedBytes(versionCode: number): number;
  getInstalledVersion(): InstalledVersion;
  openInstallPermissionSettings(): void;
  /** While held (a trip is active), no install session is committed and no prompt opens. */
  setInstallHold(held: boolean): void;
  /**
   * Rejects with a code: `digest-mismatch`, `not-an-apk`, `wrong-package`, `wrong-signer`,
   * `not-newer`, `missing`, `failed`; a rejected file has been deleted. `deferred` means the
   * install was held for a trip and the verified file is kept.
   */
  verifyAndInstall(versionCode: number, sha256: string): Promise<void>;
}

/** Present only in Android builds; iOS has no updater module. */
export const NavOSSUpdater = requireOptionalNativeModule<NavOSSUpdaterModule>('NavOSSUpdater');
