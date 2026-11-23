import { NativeModule, requireOptionalNativeModule } from 'expo';

export interface InstalledVersion {
  /** Android 12+ and NavOSS is its own installer of record: updates install without a prompt. */
  updatesWithoutPrompt: boolean;
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
  /**
   * Rejects with a code: `digest-mismatch`, `not-an-apk`, `wrong-package`, `wrong-signer`,
   * `not-newer`, `missing`, `failed`. A rejected file has been deleted.
   */
  verifyAndInstall(versionCode: number, sha256: string): Promise<void>;
}

/** Present only in Android builds; iOS has no updater module. */
export const NavOSSUpdater = requireOptionalNativeModule<NavOSSUpdaterModule>('NavOSSUpdater');
