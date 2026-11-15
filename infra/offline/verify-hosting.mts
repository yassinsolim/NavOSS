// Checks that every artifact a manifest names is served the way the app downloads it: 200 with the
// manifest's exact length, immutable caching, identity encoding, and resumable byte ranges.
// Each artifact costs one HEAD and one 16-byte ranged GET (at most two R2 Class B operations when
// the CDN does not answer from cache); --sha256 also downloads every artifact once in full.
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

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

/** Problems with one artifact's HEAD and ranged-GET answers; empty when it is served correctly. */
export function hostingProblems(
  artifact: Artifact,
  head: { status: number; headers: Headers },
  tail: { status: number; headers: Headers; bytes: number },
): string[] {
  const problems: string[] = [];
  const size = artifact.byteSize;
  if (head.status !== 200) problems.push(`HEAD ${head.status}`);
  if (head.headers.get('content-length') !== String(size))
    problems.push(`length ${head.headers.get('content-length')} != ${size}`);
  if (head.headers.get('accept-ranges') !== 'bytes') problems.push('no byte ranges advertised');
  for (const response of [head, tail]) {
    const encoding = response.headers.get('content-encoding');
    if (encoding && encoding !== 'identity') problems.push(`content-encoding ${encoding}`);
  }
  if (!/\bimmutable\b/.test(head.headers.get('cache-control') ?? ''))
    problems.push('not cached as immutable');
  const start = Math.max(0, size - TAIL);
  if (tail.status !== 206) problems.push(`range GET ${tail.status}`);
  if (tail.headers.get('content-range') !== `bytes ${start}-${size - 1}/${size}`)
    problems.push(`content-range ${tail.headers.get('content-range')}`);
  if (tail.bytes !== size - start) problems.push(`range body ${tail.bytes} bytes`);
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
  const artifacts = manifestArtifacts(JSON.parse(await readFile(positionals[0]!, 'utf8')));
  let failed = 0;
  let requests = 0;
  for (const artifact of artifacts) {
    const headers = { 'accept-encoding': 'identity' };
    const head = await fetch(artifact.url, { method: 'HEAD', headers });
    const start = Math.max(0, artifact.byteSize - TAIL);
    const tailResponse = await fetch(artifact.url, {
      headers: { ...headers, range: `bytes=${start}-` },
    });
    const body = new Uint8Array(await tailResponse.arrayBuffer());
    requests += 2;
    const problems = hostingProblems(artifact, head, {
      status: tailResponse.status,
      headers: tailResponse.headers,
      bytes: body.byteLength,
    });
    if (values.sha256) {
      const full = await sha256Of(artifact.url);
      requests += 1;
      if (full.bytes !== artifact.byteSize || full.sha256 !== artifact.sha256)
        problems.push(`SHA-256 or length mismatch (${full.bytes} bytes)`);
    }
    const cache = `cache ${tailResponse.headers.get('cf-cache-status') ?? 'n/a'}`;
    console.log(
      `${problems.length === 0 ? 'ok  ' : 'FAIL'} ${artifact.url} ${artifact.byteSize} ${cache}` +
        (problems.length === 0 ? '' : `: ${problems.join('; ')}`),
    );
    if (problems.length > 0) failed += 1;
  }
  console.log(
    `${artifacts.length - failed}/${artifacts.length} artifacts served correctly; ${requests} requests`,
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
