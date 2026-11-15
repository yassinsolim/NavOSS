// Checks that every artifact a manifest names is served the way the app downloads it: the
// manifest's exact length (as the Content-Range total), immutable caching, identity encoding, and resumable byte ranges. It
// also checks that the zone's WAF allowlist is in place: a query string, an unpublished path or a
// HEAD on the download host must be refused (403) before it can reach R2, and every file must fit the CDN
// cache. Each artifact costs two small ranged GETs (at most two R2 Class B operations
// when the CDN does not answer from cache); --sha256 also downloads every artifact once in full.
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

import { CACHE_LIMIT_BYTES, oversizedArtifacts } from './hosting.mjs';
import { validateManifest } from './tools.mjs';

const TAIL = 16;

export interface Artifact {
  url: string;
  byteSize: number;
  sha256: string;
}

export function manifestArtifacts(manifest: unknown): Artifact[] {
  const unique = new Map<string, Artifact>();
  for (const region of validateManifest(manifest).regions) {
    for (const { url, byteSize, sha256 } of Object.values(region.artifacts)) {
      const known = unique.get(url);
      if (known && (known.byteSize !== byteSize || known.sha256 !== sha256))
        throw new Error(`Conflicting manifest entries for ${url}`);
      unique.set(url, { url, byteSize, sha256 });
    }
  }
  return [...unique.values()].sort((left, right) => left.url.localeCompare(right.url, 'en'));
}

interface Answer {
  status: number;
  headers: Headers;
  bytes: number;
}

/**
 * Problems with one artifact's first-byte and last-bytes ranged GETs; empty when it is served
 * correctly. GET, not HEAD: Cloudflare does not answer HEAD from cache, so each HEAD reaches R2.
 */
export function hostingProblems(artifact: Artifact, first: Answer, tail: Answer): string[] {
  const problems: string[] = [];
  const size = artifact.byteSize;
  const start = Math.max(0, size - TAIL);
  const expected: [Answer, string, number][] = [
    [first, `bytes 0-0/${size}`, 1],
    [tail, `bytes ${start}-${size - 1}/${size}`, size - start],
  ];
  for (const [answer, range, bytes] of expected) {
    if (answer.status !== 206) problems.push(`range GET ${answer.status}`);
    if (answer.headers.get('content-range') !== range)
      problems.push(`content-range ${answer.headers.get('content-range')} != ${range}`);
    if (answer.bytes !== bytes) problems.push(`range body ${answer.bytes} bytes`);
    const encoding = answer.headers.get('content-encoding');
    if (encoding && encoding !== 'identity') problems.push(`content-encoding ${encoding}`);
  }
  if (!/\bimmutable\b/.test(first.headers.get('cache-control') ?? ''))
    problems.push('not cached as immutable');
  return problems;
}

async function sha256Of(url: string): Promise<{ sha256: string; bytes: number }> {
  const response = await fetch(url, { headers: { 'accept-encoding': 'identity' } });
  if (response.status !== 200 || !response.body) throw new Error(`GET ${response.status}`);
  const hash = createHash('sha256');
  let bytes = 0;
  for await (const chunk of response.body) {
    hash.update(chunk);
    bytes += chunk.byteLength;
  }
  return { sha256: hash.digest('hex'), bytes };
}

export async function main(args: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: { sha256: { type: 'boolean', default: false } },
  });
  if (positionals.length !== 1) {
    console.error('Usage: node --import tsx infra/offline/verify-hosting.mts MANIFEST [--sha256]');
    return 2;
  }
  const manifest: unknown = JSON.parse(await readFile(positionals[0]!, 'utf8'));
  const artifacts = manifestArtifacts(manifest);
  let failed = 0;
  let requests = 0;
  for (const artifact of artifacts) {
    const headers = { 'accept-encoding': 'identity' };
    const answer = async (range: string): Promise<Answer> => {
      const response = await fetch(artifact.url, { headers: { ...headers, range } });
      const body = new Uint8Array(await response.arrayBuffer());
      return { status: response.status, headers: response.headers, bytes: body.byteLength };
    };
    const first = await answer('bytes=0-0');
    const tail = await answer(`bytes=${Math.max(0, artifact.byteSize - TAIL)}-`);
    requests += 2;
    const problems = hostingProblems(artifact, first, tail);
    if (values.sha256) {
      const full = await sha256Of(artifact.url);
      requests += 1;
      if (full.bytes !== artifact.byteSize || full.sha256 !== artifact.sha256)
        problems.push(`SHA-256 or length mismatch (${full.bytes} bytes)`);
    }
    const cache = `cache ${tail.headers.get('cf-cache-status') ?? 'n/a'}`;
    console.log(
      `${problems.length === 0 ? 'ok  ' : 'FAIL'} ${artifact.url} ${artifact.byteSize} ${cache}` +
        (problems.length === 0 ? '' : `: ${problems.join('; ')}`),
    );
    if (problems.length > 0) failed += 1;
  }
  const first = artifacts[0]!;
  const probes = [
    {
      what: 'query string on a published file',
      url: `${first.url}?navoss-verify=1`,
      method: 'GET',
    },
    {
      what: 'unpublished path',
      url: new URL('navoss-verify-unpublished', first.url).href,
      method: 'GET',
    },
    // Cloudflare never answers HEAD from cache, so an allowed HEAD would reach R2.
    { what: 'HEAD on a published file', url: first.url, method: 'HEAD' },
  ];
  for (const probe of probes) {
    const response = await fetch(probe.url, {
      method: probe.method,
      headers: { range: 'bytes=0-0' },
    });
    await response.arrayBuffer();
    requests += 1;
    const ok = response.status === 403;
    console.log(
      `${ok ? 'ok  ' : 'FAIL'} WAF refuses ${probe.what}: ${response.status}` +
        (ok
          ? ''
          : ' (the zone allowlist rule is missing, outdated or does not cover this release)'),
    );
    if (!ok) failed += 1;
  }
  for (const { url, byteSize } of oversizedArtifacts([manifest])) {
    console.log(
      `FAIL ${url} is ${byteSize} bytes, above the ${CACHE_LIMIT_BYTES}-byte cache limit`,
    );
    failed += 1;
  }
  console.log(
    `${artifacts.length + probes.length - failed}/${artifacts.length + probes.length} checks passed; ${requests} requests`,
  );
  return failed === 0 ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (error: unknown) => {
      console.error(error instanceof Error ? error.message : 'Hosting verification failed');
      process.exitCode = 2;
    },
  );
}
