// Hosting rules derived from published manifests. Plain Node runs it (type stripping):
//   node infra/offline/hosting.mts waf-expression MANIFEST [MANIFEST…]   prints the WAF expression
//   node infra/offline/hosting.mts waf-rule MANIFEST [MANIFEST…]         prints the rule JSON body
//   node infra/offline/hosting.mts cache-check MANIFEST                  exit 1 if a file is too big
// Pass the old and the new manifest together while both releases are served (grace period).
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

/**
 * Cloudflare's largest cacheable object on Free/Pro/Business ("512 MB"). Measured 2026-11-15: the
 * 524,743,452-byte all-Alberta maps file is served from cache, so the limit is 512 MiB.
 */
export const CACHE_LIMIT_BYTES = 512 * 1024 * 1024;

export const WAF_RULE_DESCRIPTION = 'navoss-offline: only published files, GET, no query';

interface ManifestLike {
  regions: { artifacts: Record<string, { url: string; byteSize: number }> }[];
}

function asManifest(value: unknown): ManifestLike {
  const regions =
    typeof value === 'object' && value !== null && 'regions' in value ? value.regions : undefined;
  if (!Array.isArray(regions) || regions.length === 0) throw new Error('Manifest has no regions');
  for (const region of regions) {
    const artifacts =
      typeof region === 'object' && region !== null && 'artifacts' in region
        ? region.artifacts
        : undefined;
    if (typeof artifacts !== 'object' || artifacts === null)
      throw new Error('Region has no artifacts');
    for (const artifact of Object.values(artifacts)) {
      if (
        typeof artifact !== 'object' ||
        artifact === null ||
        typeof artifact.url !== 'string' ||
        typeof artifact.byteSize !== 'number'
      )
        throw new Error('Artifact without url and byteSize');
    }
  }
  return value as ManifestLike; // every member read below was checked above
}

/** Every artifact in manifest order (regions, then maps/routing/search/resources), once each. */
export function artifactsOf(manifests: unknown[]): { url: URL; byteSize: number }[] {
  const seen = new Map<string, { url: URL; byteSize: number }>();
  for (const manifest of manifests.map(asManifest)) {
    for (const region of manifest.regions) {
      for (const artifact of Object.values(region.artifacts)) {
        if (!seen.has(artifact.url))
          seen.set(artifact.url, { url: new URL(artifact.url), byteSize: artifact.byteSize });
      }
    }
  }
  return [...seen.values()];
}

/**
 * The zone's WAF custom rule expression: on the download host, block everything except GET without
 * a query string for exactly the published artifact paths. Unknown paths, scanners, cache-busting
 * query strings and HEAD (which Cloudflare never answers from cache) then never reach R2.
 */
export function wafExpression(manifests: unknown[]): string {
  const artifacts = artifactsOf(manifests);
  const hosts = new Set(artifacts.map(({ url }) => url.host));
  if (hosts.size !== 1)
    throw new Error(`Artifacts must share one host, found ${[...hosts].join(', ')}`);
  for (const { url } of artifacts) {
    if (url.protocol !== 'https:' || url.search || url.hash || url.username || url.password)
      throw new Error(`Artifact URL must be plain HTTPS: ${url.href}`);
    // Keys are content-addressed release paths; anything else must not reach a rule expression.
    if (!/^\/[A-Za-z0-9._/-]+$/.test(url.pathname))
      throw new Error(`Unexpected path ${url.pathname}`);
  }
  const host = [...hosts][0]!;
  const paths = artifacts.map(({ url }) => `"${url.pathname}"`).join(' ');
  return (
    `(http.host eq "${host}" and (not http.request.uri.path in {${paths}} or ` +
    `http.request.uri.query ne "" or http.request.method ne "GET"))`
  );
}

/** Rules API body for the zone's `http_request_firewall_custom` phase. */
export function wafRule(manifests: unknown[]) {
  return {
    description: WAF_RULE_DESCRIPTION,
    expression: wafExpression(manifests),
    action: 'block',
    enabled: true,
  };
}

/** Artifacts too large for the CDN cache: every download of them would reach R2. */
export function oversizedArtifacts(manifests: unknown[]): { url: string; byteSize: number }[] {
  return artifactsOf(manifests)
    .filter(({ byteSize }) => byteSize > CACHE_LIMIT_BYTES)
    .map(({ url, byteSize }) => ({ url: url.href, byteSize }));
}

export async function main(args: string[]): Promise<number> {
  const [command, ...paths] = args;
  if (
    !command ||
    paths.length === 0 ||
    !['waf-expression', 'waf-rule', 'cache-check'].includes(command)
  ) {
    console.error(
      'Usage: node infra/offline/hosting.mts waf-expression|waf-rule|cache-check MANIFEST…',
    );
    return 2;
  }
  const manifests: unknown[] = await Promise.all(
    paths.map(async (path) => JSON.parse(await readFile(path, 'utf8'))),
  );
  if (command === 'waf-expression') console.log(wafExpression(manifests));
  else if (command === 'waf-rule') console.log(JSON.stringify(wafRule(manifests), null, 2));
  else {
    const oversized = oversizedArtifacts(manifests);
    for (const { url, byteSize } of oversized)
      console.error(
        `WARNING: ${url} is ${byteSize} bytes, above the ${CACHE_LIMIT_BYTES}-byte cache limit; every download reaches R2`,
      );
    if (oversized.length > 0) return 1;
    console.log(`Every artifact fits the CDN cache (at most ${CACHE_LIMIT_BYTES} bytes)`);
  }
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (error: unknown) => {
      console.error(error instanceof Error ? error.message : 'Hosting helper failed');
      process.exitCode = 2;
    },
  );
}
