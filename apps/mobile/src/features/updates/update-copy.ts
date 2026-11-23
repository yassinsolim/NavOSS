import type { CheckCode } from './update-feed';

/** Download sizes for a glance: "48 MB", "0.9 MB". Decimal megabytes, like Android's own. */
export function formatMegabytes(bytes: number): string {
  const megabytes = bytes / 1_000_000;
  if (megabytes >= 10) return `${String(Math.round(megabytes))} MB`;
  return `${megabytes.toFixed(1)} MB`;
}

export function downloadProgressLabel(received: number, total: number): string {
  if (total <= 0) return 'Downloading';
  return `${formatMegabytes(received)} of ${formatMegabytes(total)}`;
}

/** What a manual "Check now" says. Automatic checks say nothing unless there is an update. */
export function checkResultMessage(code: CheckCode): string {
  switch (code) {
    case 'update':
      return 'An update is available.';
    case 'up-to-date':
    case 'no-release':
      return 'NavOSS is up to date.';
    case 'no-network':
      return 'No connection. Try again in a moment.';
    case 'rate-limited':
      return 'GitHub is busy. Try again in an hour.';
    case 'malformed':
    case 'unavailable':
      return 'Couldn’t check for updates. Try again later.';
  }
}

/** Plain copy for a download, verification or install failure code from the native updater. */
export function updateFailureMessage(code: string): string {
  switch (code) {
    case 'network':
      return 'The download stopped. Check your connection and try again; it continues where it stopped.';
    case 'storage':
      return 'There isn’t enough free storage for the update. Free up some space and try again.';
    case 'digest-mismatch':
    case 'not-an-apk':
    case 'size':
      return 'The download was damaged or changed, so NavOSS deleted it. Try again.';
    case 'wrong-package':
    case 'wrong-signer':
      return 'This file isn’t signed by NavOSS, so it was deleted and not installed.';
    case 'not-newer':
      return 'The download isn’t newer than this version, so it was deleted.';
    case 'blocked':
      return 'Android blocked the update. Check that installs from NavOSS are allowed, then try again.';
    case 'conflict':
    case 'incompatible':
    case 'invalid':
      return 'Android couldn’t install this update on this device.';
    default:
      return 'The update couldn’t be installed. Try again later.';
  }
}
