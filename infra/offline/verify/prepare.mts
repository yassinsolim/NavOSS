import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs, promisify } from 'node:util';
import { inspectArtifact } from '../tools.mjs';

const exec = promisify(execFile);
const directory = dirname(fileURLToPath(import.meta.url));
const RENDERER_FILES = [
  'maplibre/maplibre-gl.mjs',
  'maplibre/maplibre-gl-worker.mjs',
  'maplibre/maplibre-gl-shared.mjs',
  'maplibre/maplibre-gl.css',
  'pmtiles/pmtiles.js',
];

async function* bodyBytes(body: ReadableStream<Uint8Array>) {
  const reader = body.getReader();
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) return;
      yield part.value;
    }
  } finally {
    reader.releaseLock();
  }
}

export async function prepareRenderer(root: string): Promise<void> {
  const lockText = await readFile(join(directory, 'sources.lock.json'), 'utf8');
  const identity = createHash('sha256').update(lockText).digest('hex');
  const vendor = join(root, 'verify/vendor');
  const marker = join(vendor, 'complete.json');
  try {
    const cached = JSON.parse(await readFile(marker, 'utf8')) as {
      identity: string;
      files: Record<string, { byteSize: number; sha256: string }>;
    };
    if (cached.identity === identity) {
      for (const name of RENDERER_FILES) {
        const expected = cached.files?.[name];
        const actual = await inspectArtifact(join(vendor, name));
        if (
          !expected ||
          expected.byteSize !== actual.byteSize ||
          expected.sha256 !== actual.sha256
        ) {
          throw new Error('Corrupt cached renderer files');
        }
      }
      return;
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  await mkdir(vendor, { recursive: true });
  const lock = JSON.parse(lockText) as {
    schemaVersion: number;
    packages: { name: string; url: string; sha512: string }[];
  };
  if (lock.schemaVersion !== 1) throw new Error('Unsupported renderer lock');
  for (const entry of lock.packages) {
    const archive = join(vendor, `${entry.name}.tgz`);
    let actual: string;
    let cached = true;
    const hash = createHash('sha512');
    try {
      for await (const bytes of createReadStream(archive)) hash.update(bytes);
      actual = hash.digest('base64');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      cached = false;
      const response = await fetch(entry.url);
      if (!response.ok || !response.body)
        throw new Error(`Renderer download failed: ${entry.name}`);
      const downloadedHash = createHash('sha512');
      const tap = new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          downloadedHash.update(chunk);
          callback(null, chunk);
        },
      });
      await pipeline(
        Readable.from(bodyBytes(response.body), { objectMode: false }),
        tap,
        createWriteStream(`${archive}.partial`),
      );
      actual = downloadedHash.digest('base64');
    }
    if (actual !== entry.sha512)
      throw new Error(
        `${cached ? 'Cached renderer' : 'Renderer'} checksum mismatch: ${entry.name}`,
      );
    if (!cached) await rename(`${archive}.partial`, archive);
    const destination = join(vendor, entry.name === 'maplibre-gl' ? 'maplibre' : entry.name);
    await mkdir(destination, { recursive: true });
    await exec('tar', [
      '-xzf',
      archive,
      '-C',
      destination,
      '--strip-components=2',
      entry.name === 'maplibre-gl' ? 'package/dist' : 'package/dist/pmtiles.js',
    ]);
  }
  const files = Object.fromEntries(
    await Promise.all(
      RENDERER_FILES.map(async (name) => [name, await inspectArtifact(join(vendor, name))]),
    ),
  );
  await writeFile(marker, JSON.stringify({ identity, files }) + '\n');
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const { values } = parseArgs({
    options: { root: { type: 'string', default: 'artifacts/offline' } },
  });
  await prepareRenderer(resolve(directory, '../../..', values.root));
  console.log('Checksummed local renderer assets ready.');
}
