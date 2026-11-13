import type {
  NativeOfflineErrorCode,
  NativeOfflineRegion,
  NativeOfflineState,
} from '../../../modules/navoss-navigation';

/** How an on-device route describes itself wherever the phone shows a route's source. */
export const OFFLINE_ROUTE_SOURCE = {
  attribution: 'Offline route · No traffic or closures',
  id: 'offline-valhalla',
  mode: 'offline',
  traffic: 'unavailable',
} as const;

export type OfflineRouteSource = typeof OFFLINE_ROUTE_SOURCE;

/** Decimal units, as iOS reports storage. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '—';
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(bytes >= 1e10 ? 0 : 1)} GB`;
  if (bytes >= 1e6) return `${String(Math.round(bytes / 1e6))} MB`;
  if (bytes >= 1e3) return `${String(Math.round(bytes / 1e3))} KB`;
  return `${String(Math.round(bytes))} bytes`;
}

export function offlineRouteMessage(code: NativeOfflineErrorCode): string {
  switch (code) {
    case 'outside-coverage':
      return 'The NavOSS service is unreachable and this trip leaves your downloaded offline maps.';
    case 'no-route':
      return 'No driving route was found in your offline maps.';
    case 'not-installed':
      return 'Download an offline region to plan routes without a connection.';
    case 'engine-unavailable':
      return 'Offline routing could not start. Try again, or reconnect to plan the route online.';
  }
}

export interface OfflineNotice {
  message: string;
  title: string;
  tone: 'danger' | 'info' | 'neutral' | 'warning';
}

/** The banner at the top of the Offline maps screen, if the catalog needs explaining. */
export function offlineCatalogNotice(state: NativeOfflineState): OfflineNotice | undefined {
  const installed = state.regions.some((region) => region.installedVersion !== undefined);
  switch (state.catalog) {
    case 'loading':
      return undefined;
    case 'not-published':
      return installed
        ? {
            message: 'Regions on this device keep working. No newer offline maps are published.',
            title: 'No offline downloads right now',
            tone: 'neutral',
          }
        : {
            message:
              'NavOSS has not published downloadable regions yet. Maps, search and routing need a connection for now.',
            title: 'Offline maps are not available yet',
            tone: 'neutral',
          };
    case 'unreachable':
      return {
        message: installed
          ? 'Regions on this device keep working. Connect to check for updates.'
          : 'Connect to the internet to see which regions you can download.',
        title: 'Can’t reach NavOSS',
        tone: 'warning',
      };
    case 'unsupported':
      return {
        message: 'The published offline maps need a newer version of NavOSS.',
        title: 'Update NavOSS to download offline maps',
        tone: 'warning',
      };
    case 'available':
      return state.stale
        ? {
            message: 'These are the regions from your last check. Connect to see updates.',
            title: 'Showing saved list',
            tone: 'neutral',
          }
        : undefined;
  }
}

function progress(region: NativeOfflineRegion): string {
  const received = region.receivedBytes ?? 0;
  const total = region.totalBytes ?? region.downloadBytes;
  return `${formatBytes(received)} of ${formatBytes(total)}`;
}

/** Percent complete for a progress bar, 0–1. */
export function regionProgress(region: NativeOfflineRegion): number | undefined {
  if (region.state !== 'downloading' && region.state !== 'paused') return undefined;
  const total = region.totalBytes ?? 0;
  if (total <= 0) return 0;
  return Math.min(1, Math.max(0, (region.receivedBytes ?? 0) / total));
}

export function regionFailureMessage(region: NativeOfflineRegion): string | undefined {
  const failure = region.failure;
  if (failure === undefined) return undefined;
  switch (failure.reason) {
    case 'storage':
      return `Not enough free space. This needs ${formatBytes(failure.requiredBytes ?? 0)}; ${formatBytes(failure.availableBytes ?? 0)} is free.`;
    case 'network':
      return 'The download was interrupted. Resume continues where it stopped.';
    case 'server':
      return `The download server returned an error${failure.statusCode === undefined ? '' : ` (${String(failure.statusCode)})`}. Try again later.`;
    case 'integrity':
      return 'The download did not match its checksum and was discarded. Try again.';
    case 'unsupported':
      return 'This region needs a newer version of NavOSS.';
    case 'installation':
      return 'The region could not be installed. Try again.';
  }
}

/** The status line under a region's name. */
export function regionStatusText(region: NativeOfflineRegion): string {
  switch (region.state) {
    case 'not-downloaded':
      return `${formatBytes(region.downloadBytes)} download`;
    case 'queued':
      return 'Waiting to download';
    case 'downloading':
      return `Downloading · ${progress(region)}`;
    case 'paused':
      return `Paused · ${progress(region)}`;
    case 'verifying':
      return 'Checking the download';
    case 'installing':
      return 'Installing';
    case 'installed':
      return [
        `On this device · ${formatBytes(region.installedBytes ?? 0)}`,
        region.installedDataDate === undefined ? undefined : `Map data ${region.installedDataDate}`,
        region.updateAvailable ? 'Update available' : undefined,
      ]
        .filter((part) => part !== undefined)
        .join(' · ');
    case 'failed':
      return region.installedVersion === undefined ? 'Download failed' : 'Update failed';
  }
}

export type RegionAction = 'cancel' | 'delete' | 'download' | 'pause' | 'resume' | 'update';

/** The actions a region row offers, primary first. */
export function regionActions(region: NativeOfflineRegion, canDownload: boolean): RegionAction[] {
  const installed = region.installedVersion !== undefined;
  switch (region.state) {
    case 'not-downloaded':
      return canDownload ? ['download'] : [];
    case 'queued':
    case 'downloading':
      return ['pause', 'cancel'];
    case 'paused':
      return canDownload ? ['resume', 'cancel'] : ['cancel'];
    case 'failed':
      return [
        ...(canDownload ? (['resume'] as const) : []),
        ...(installed ? (['delete'] as const) : (['cancel'] as const)),
      ];
    case 'verifying':
    case 'installing':
      return [];
    case 'installed':
      return region.updateAvailable && canDownload ? ['update', 'delete'] : ['delete'];
  }
}

/** Search-source line for results answered from the offline index. */
export function offlineSearchSourceLabel(updatedAt: string): string {
  const date = /^\d{4}-\d{2}-\d{2}/.exec(updatedAt)?.[0];
  return date === undefined
    ? 'Offline results · OpenStreetMap'
    : `Offline results · OpenStreetMap data from ${date}`;
}
