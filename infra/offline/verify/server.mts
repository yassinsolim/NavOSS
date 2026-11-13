import { once } from 'node:events';
import { createReadStream } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { dirname, extname, join, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

import { bindOfflineStyle, validateManifest, type OfflineStyle } from '../tools.mjs';

const directory = dirname(fileURLToPath(import.meta.url));
const repo = resolve(directory, '../../..');

export function safePath(root: string, relativePath: string): string {
  const decoded = decodeURIComponent(relativePath);
  if (decoded.includes('\0') || decoded.includes('\\')) throw new Error('Invalid resource path');
  const absoluteRoot = resolve(root);
  const path = resolve(absoluteRoot, `.${decoded.startsWith('/') ? decoded : '/' + decoded}`);
  if (path !== absoluteRoot && !path.startsWith(absoluteRoot + sep))
    throw new Error('Resource path escapes its root');
  return path;
}

export function byteRange(
  value: string | undefined,
  size: number,
): { start: number; end: number; partial: boolean } {
  if (!Number.isSafeInteger(size) || size <= 0) throw new Error('Invalid resource size');
  if (!value) return { start: 0, end: size - 1, partial: false };
  const match = /^bytes=(\d*)-(\d*)$/.exec(value);
  if (!match || (!match[1] && !match[2])) throw new Error('Unsupported byte range');
  let start: number;
  let end: number;
  if (!match[1]) {
    const suffix = Number(match[2]);
    if (!Number.isSafeInteger(suffix) || suffix <= 0) throw new Error('Invalid suffix range');
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(match[1]);
    end = match[2] ? Number(match[2]) : size - 1;
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start >= size || end < start)
      throw new Error('Unsatisfiable byte range');
    end = Math.min(end, size - 1);
  }
  return { start, end, partial: true };
}

export function contentSecurityPolicy(): string {
  return "default-src 'none'; script-src 'self' 'unsafe-inline'; worker-src 'self' blob:; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; font-src 'self'; base-uri 'none'; form-action 'none'";
}

async function serveFile(request: IncomingMessage, response: ServerResponse, path: string) {
  const info = await stat(path);
  if (!info.isFile()) {
    response.writeHead(404).end();
    return;
  }
  let range;
  try {
    range = byteRange(request.headers.range, info.size);
  } catch {
    response.writeHead(416, { 'Content-Range': `bytes */${info.size}` }).end();
    return;
  }
  const contentTypes: Record<string, string> = {
    '.mjs': 'text/javascript',
    '.js': 'text/javascript',
    '.css': 'text/css',
    '.html': 'text/html',
    '.json': 'application/json',
    '.png': 'image/png',
  };
  const headers: Record<string, string | number> = {
    'Content-Type': contentTypes[extname(path)] ?? 'application/octet-stream',
    'Content-Length': range.end - range.start + 1,
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  };
  if (range.partial) headers['Content-Range'] = `bytes ${range.start}-${range.end}/${info.size}`;
  response.writeHead(range.partial ? 206 : 200, headers);
  if (request.method === 'HEAD') {
    response.end();
    return;
  }
  const stream = createReadStream(path, { start: range.start, end: range.end });
  stream.on('error', () => response.destroy());
  response.on('close', () => stream.destroy());
  stream.pipe(response);
}

export async function verificationServer(root: string, regionId: string, port: number) {
  const manifest = validateManifest(
    JSON.parse(await readFile(join(root, 'manifest.json'), 'utf8')),
  );
  const region = manifest.regions.find((entry) => entry.id === regionId);
  if (!region) throw new Error('Region is not present in the built manifest');
  const release = join(root, 'releases', manifest.bundleVersion);
  const report = JSON.parse(await readFile(join(release, 'build-report.json'), 'utf8')) as {
    caches: { resources: string };
  };
  const resources = safePath(root, '/' + report.caches.resources + '/resources');
  const origin = `http://127.0.0.1:${port}`;
  const server = createServer(async (request, response) => {
    response.setHeader('Content-Security-Policy', contentSecurityPolicy());
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      response.writeHead(405).end();
      return;
    }
    try {
      const url = new URL(request.url ?? '/', origin);
      if (url.pathname === '/config.json') {
        response
          .writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
          .end(
            JSON.stringify({
              region: region.name,
              dataDate: manifest.dataDate,
              bundleVersion: manifest.bundleVersion,
              mapsByteSize: region.artifacts.maps.byteSize,
            }),
          );
      } else if (url.pathname === '/style.json') {
        const styleName = url.searchParams.get('name') ?? 'liberty';
        if (!['liberty', 'bright', 'positron', 'dark'].includes(styleName)) {
          response.writeHead(404).end();
          return;
        }
        const source = JSON.parse(
          await readFile(join(resources, 'styles', `${styleName}.json`), 'utf8'),
        ) as OfflineStyle;
        const style = bindOfflineStyle(source, `${origin}/bundle`, `${origin}/resources`, 'web');
        response
          .writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
          .end(JSON.stringify(style));
      } else if (url.pathname === '/bundle/maps.pmtiles') {
        await serveFile(request, response, join(release, 'regions', regionId, 'maps.pmtiles'));
      } else if (url.pathname.startsWith('/resources/')) {
        await serveFile(
          request,
          response,
          safePath(resources, url.pathname.slice('/resources'.length)),
        );
      } else if (url.pathname.startsWith('/vendor/')) {
        await serveFile(
          request,
          response,
          safePath(join(root, 'verify/vendor'), url.pathname.slice('/vendor'.length)),
        );
      } else if (url.pathname === '/' || url.pathname === '/index.html') {
        await serveFile(request, response, join(directory, 'index.html'));
      } else if (url.pathname.startsWith(`/${manifest.bundleVersion}/`)) {
        await serveFile(request, response, safePath(join(root, 'releases'), url.pathname));
      } else response.writeHead(404).end();
    } catch (error) {
      if (!response.headersSent)
        response.writeHead((error as NodeJS.ErrnoException).code === 'ENOENT' ? 404 : 400).end();
      else response.destroy();
    }
  });
  const listening = once(server, 'listening');
  server.listen(port, '127.0.0.1');
  await listening;
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const { values } = parseArgs({
    options: {
      root: { type: 'string', default: 'artifacts/offline' },
      region: { type: 'string', default: 'calgary' },
      port: { type: 'string', default: '3021' },
    },
  });
  const port = Number(values.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error('Invalid verification port');
  const server = await verificationServer(resolve(repo, values.root), values.region, port);
  console.log(
    `Offline verifier ready: http://127.0.0.1:${port}/ (external network blocked by CSP)`,
  );
  const close = () => server.close();
  process.on('SIGINT', close);
  process.on('SIGTERM', close);
}
