/**
 * Reading NavOSS Android releases from the GitHub Releases API.
 *
 * One request, `GET /repos/yassinsolim/NavOSS/releases`, answers everything the updater needs:
 * the list holds iOS and Android releases together (so `/releases/latest` could name an iOS
 * release), the tag carries the version name and version code, and each asset carries its size
 * and a SHA-256 `digest` that GitHub computes itself on upload. Fetching the release's
 * `update.json` instead would need a second request to a second host for the same facts.
 * Anonymous requests see published releases only; drafts and pre-releases are skipped anyway.
 */

export const RELEASES_URL = 'https://api.github.com/repos/yassinsolim/NavOSS/releases?per_page=30';

/**
 * Test builds only: `EXPO_PUBLIC_NAVOSS_UPDATE_FEED_URL` replaces the releases URL with a local
 * fake. Metro inlines the variable at bundle time, so a build made without it contains only the
 * GitHub URL; the release workflow refuses to build with it set.
 */
export function releasesUrl(): string {
  const override: unknown = process.env.EXPO_PUBLIC_NAVOSS_UPDATE_FEED_URL;
  return typeof override === 'string' && override !== '' ? override : RELEASES_URL;
}

/**
 * The largest APK offered (the native downloader refuses it too). The release APK is about 48 MB;
 * the ceiling leaves room to grow and ignores a release that announces something absurd.
 */
export const MAX_APK_BYTES = 250_000_000;

export interface AvailableUpdate {
  apkName: string;
  apkUrl: string;
  /** Upper-case hex. */
  sha256: string;
  sizeBytes: number;
  tag: string;
  versionCode: number;
  versionName: string;
}

export type FeedResult =
  | { kind: 'malformed' }
  | { kind: 'no-release' }
  | { kind: 'up-to-date'; latestVersionCode: number }
  | { kind: 'update'; update: AvailableUpdate };

const TAG_PATTERN = /^android-v(\d+\.\d+\.\d+)-(\d{1,10})$/;

export function parseReleaseTag(
  tag: string,
): { versionCode: number; versionName: string } | undefined {
  const match = TAG_PATTERN.exec(tag);
  if (match === null) return undefined;
  const versionCode = Number(match[2]);
  if (!Number.isSafeInteger(versionCode) || versionCode < 1) return undefined;
  return { versionCode, versionName: match[1] };
}

/** The fields of a GitHub release the updater reads; each is checked before use. */
interface ReleaseFields {
  assets?: unknown;
  draft?: unknown;
  prerelease?: unknown;
  tag_name?: unknown;
}

interface AssetFields {
  browser_download_url?: unknown;
  digest?: unknown;
  name?: unknown;
  size?: unknown;
  state?: unknown;
}

/** `sha256:<hex>` from GitHub, as upper-case hex; undefined for anything else. */
export function parseDigest(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const match = /^sha256:([0-9a-fA-F]{64})$/.exec(value);
  return match === null ? undefined : match[1].toUpperCase();
}

/**
 * Asset downloads must come from GitHub over HTTPS. A test feed (see [releasesUrl]) may also
 * serve them from its own origin.
 */
export function isAllowedDownloadUrl(value: string, feedUrl: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.protocol === 'https:' && url.hostname === 'github.com') {
    return url.pathname.startsWith('/yassinsolim/NavOSS/releases/download/');
  }
  if (feedUrl === RELEASES_URL) return false;
  return url.origin === new URL(feedUrl).origin;
}

/** The update a release offers, or undefined when it has no usable APK. */
function releaseUpdate(release: ReleaseFields, feedUrl: string): AvailableUpdate | undefined {
  if (release.draft !== false || release.prerelease !== false) return undefined;
  if (typeof release.tag_name !== 'string') return undefined;
  const version = parseReleaseTag(release.tag_name);
  if (version === undefined || !Array.isArray(release.assets)) return undefined;
  for (const entry of release.assets as unknown[]) {
    if (typeof entry !== 'object' || entry === null) continue;
    const asset = entry as AssetFields;
    const { browser_download_url: url, name, size, state } = asset;
    if (typeof name !== 'string' || !name.endsWith('.apk')) continue;
    if (state !== undefined && state !== 'uploaded') continue;
    if (typeof url !== 'string' || !isAllowedDownloadUrl(url, feedUrl)) continue;
    if (typeof size !== 'number' || !Number.isSafeInteger(size) || size <= 0) continue;
    if (size > MAX_APK_BYTES) continue;
    const sha256 = parseDigest(asset.digest);
    if (sha256 === undefined) continue;
    return {
      apkName: name,
      apkUrl: url,
      sha256,
      sizeBytes: size,
      tag: release.tag_name,
      versionCode: version.versionCode,
      versionName: version.versionName,
    };
  }
  return undefined;
}

/**
 * The newest published Android release with a verifiable APK, compared with the installed
 * version code. Version names are never compared.
 */
export function latestUpdate(
  json: unknown,
  installedVersionCode: number,
  feedUrl: string = RELEASES_URL,
): FeedResult {
  if (!Array.isArray(json)) return { kind: 'malformed' };
  let latest: AvailableUpdate | undefined;
  for (const release of json) {
    if (typeof release !== 'object' || release === null) continue;
    const update = releaseUpdate(release as ReleaseFields, feedUrl);
    if (update !== undefined && (latest === undefined || update.versionCode > latest.versionCode)) {
      latest = update;
    }
  }
  if (latest === undefined) return { kind: 'no-release' };
  if (latest.versionCode <= installedVersionCode) {
    return { kind: 'up-to-date', latestVersionCode: latest.versionCode };
  }
  return { kind: 'update', update: latest };
}

/** The result code of one check; the only thing the app records about it. */
export type CheckCode =
  | 'malformed'
  | 'no-network'
  | 'no-release'
  | 'rate-limited'
  | 'unavailable'
  | 'up-to-date'
  | 'update';

export function checkCodeForStatus(status: number): CheckCode | undefined {
  if (status === 200) return undefined;
  if (status === 403 || status === 429) return 'rate-limited';
  return 'unavailable';
}
