import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs, promisify } from 'node:util';

import { routingEnginePin } from '../engine.mjs';
import { validateManifest } from '../tools.mjs';

const exec = promisify(execFile);
const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
interface Trip {
  status: number;
  summary: { length: number; time: number };
  legs: { shape: string }[];
}
interface PublicCase {
  id: string;
  origin: { latitude: number; longitude: number };
  destination: { latitude: number; longitude: number };
}

export function routeSummary(source: Record<string, unknown>) {
  const length = source.length;
  const time = source.time;
  if (
    typeof length !== 'number' ||
    typeof time !== 'number' ||
    !Number.isFinite(length) ||
    !Number.isFinite(time) ||
    length <= 0 ||
    time <= 0
  ) {
    throw new Error('Route summary must contain positive measured distance and time');
  }
  return { length, time };
}

export function comparison(
  online: { length: number; time: number },
  offline: { length: number; time: number },
) {
  if (!(online.length > 0 && online.time > 0 && offline.length > 0 && offline.time > 0)) {
    throw new Error('Route comparison requires positive measured distances and times');
  }
  return {
    distanceMeters: Math.round((offline.length - online.length) * 1000),
    timeSeconds: Math.round(offline.time - online.time),
    distancePercent: Math.round((offline.length / online.length - 1) * 10000) / 100,
    timePercent: Math.round((offline.time / online.time - 1) * 10000) / 100,
  };
}

async function action(url: string, path: string, body: unknown): Promise<Trip> {
  const response = await fetch(`${url}/${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`Valhalla ${path} returned HTTP ${response.status}`);
  const parsed = (await response.json()) as { trip: Trip };
  if (parsed.trip?.status !== 0 || !parsed.trip.legs?.length)
    throw new Error(`Valhalla ${path} did not find a path`);
  return parsed.trip;
}

export async function verifyRouting(root: string, baselineGraph?: string) {
  const pin = routingEnginePin();
  const manifest = validateManifest(
    JSON.parse(await readFile(join(root, 'manifest.json'), 'utf8')),
  );
  const calgary = manifest.regions.find((region) => region.id === 'calgary');
  if (!calgary) throw new Error('The benchmark requires a built Calgary bundle');
  const release = join(root, 'releases', manifest.bundleVersion);
  const report = JSON.parse(await readFile(join(release, 'build-report.json'), 'utf8')) as {
    caches: { graph: string };
  };
  const offlineConfig = join(root, report.caches.graph, 'valhalla.json');
  const routingTar = join(release, 'regions/calgary/routing.tar');
  const containers: string[] = [];
  const directories: string[] = [];
  async function service(label: string, image: string, configPath: string, tarPath: string) {
    const directory = await mkdtemp(join(tmpdir(), 'navoss-offline-route-'));
    directories.push(directory);
    const config = JSON.parse(await readFile(configPath, 'utf8')) as {
      mjolnir: Record<string, unknown>;
      additional_data: unknown;
      logging: unknown;
    };
    config.mjolnir = {
      ...config.mjolnir,
      tile_extract: '/tiles/routing.tar',
      tile_dir: '/not-mounted',
      traffic_extract: '',
      admin: '',
      timezone: '',
      default_speeds_config: '',
      transit_dir: '',
      transit_feeds_dir: '',
    };
    config.additional_data = { elevation: '' };
    config.logging = { type: '', color: false };
    await writeFile(join(directory, 'valhalla.json'), JSON.stringify(config));
    const name = `offline-bundles-${label}-${process.pid}`;
    await exec('docker', [
      'run',
      '--detach',
      '--rm',
      '--name',
      name,
      '--cpus',
      '2',
      '--memory',
      '1g',
      '--publish',
      '127.0.0.1::8002',
      '--volume',
      `${directory}:/config:ro`,
      '--volume',
      `${tarPath}:/tiles/routing.tar:ro`,
      '--entrypoint',
      'valhalla_service',
      image,
      '/config/valhalla.json',
      '2',
    ]);
    containers.push(name);
    const port = (
      await exec('docker', [
        'inspect',
        '--format',
        '{{(index (index .NetworkSettings.Ports "8002/tcp") 0).HostPort}}',
        name,
      ])
    ).stdout.trim();
    const url = `http://127.0.0.1:${port}`;
    const deadline = Date.now() + 45_000;
    while (Date.now() < deadline) {
      try {
        if ((await fetch(`${url}/status`, { signal: AbortSignal.timeout(1000) })).ok) return url;
      } catch {
        /* process is still starting; the deadline is bounded */
      }
      await delay(100);
    }
    throw new Error(`${label} did not become ready`);
  }
  try {
    const offline = await service('offline39', pin.image, offlineConfig, routingTar);
    let online: string | undefined;
    let compatibility: string | undefined;
    if (baselineGraph) {
      const config = join(baselineGraph, 'valhalla.json');
      const tar = join(baselineGraph, 'connected.tar');
      online = await service('online38', pin.configurationImage, config, tar);
      compatibility = await service('reader39tiles38', pin.image, config, tar);
    }
    const cases = (
      JSON.parse(
        await readFile(join(repo, 'apps/api/scripts/route-quality-cases.json'), 'utf8'),
      ) as PublicCase[]
    ).slice(0, 5);
    const results = [];
    for (const item of cases) {
      const request = {
        locations: [item.origin, item.destination].map((coordinate) => ({
          lat: coordinate.latitude,
          lon: coordinate.longitude,
        })),
        costing: 'auto',
        units: 'kilometers',
        shape_format: 'polyline6',
      };
      const route = await action(offline, 'route', request);
      const shape = route.legs[0]?.shape;
      if (!shape) throw new Error('Route has no traceable shape');
      const trace = await action(offline, 'trace_route', {
        encoded_polyline: shape,
        costing: 'auto',
        shape_match: 'map_snap',
        units: 'kilometers',
      });
      const baseline = online ? await action(online, 'route', request) : undefined;
      const oldTiles = compatibility ? await action(compatibility, 'route', request) : undefined;
      const oldTrace =
        compatibility && oldTiles?.legs[0]?.shape
          ? await action(compatibility, 'trace_route', {
              encoded_polyline: oldTiles.legs[0].shape,
              costing: 'auto',
              shape_match: 'map_snap',
              units: 'kilometers',
            })
          : undefined;
      results.push({
        id: item.id,
        offline39: routeSummary(route.summary),
        trace39: { status: trace.status, ...routeSummary(trace.summary) },
        ...(baseline
          ? {
              online38: routeSummary(baseline.summary),
              delta: comparison(baseline.summary, route.summary),
            }
          : {}),
        ...(oldTiles && oldTrace
          ? {
              reader39Tiles38: {
                routeStatus: oldTiles.status,
                traceStatus: oldTrace.status,
                ...routeSummary(oldTiles.summary),
              },
            }
          : {}),
      });
    }
    return {
      dataDate: manifest.dataDate,
      bundleVersion: manifest.bundleVersion,
      routingEngineVersion: pin.routingEngineVersion,
      tileFormatVersion: pin.tileFormatVersion,
      baselineEngineVersion: baselineGraph ? pin.configurationEngineVersion : null,
      productionVmContacted: false,
      cases: results,
    };
  } finally {
    await Promise.all(containers.map((name) => exec('docker', ['stop', name])));
    await Promise.all(
      directories.map((directory) => rm(directory, { recursive: true, force: true })),
    );
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const { values } = parseArgs({
    options: {
      root: { type: 'string', default: 'artifacts/offline' },
      'baseline-graph': { type: 'string' },
      output: { type: 'string', default: 'artifacts/offline/evidence/routing.json' },
    },
  });
  const result = await verifyRouting(
    resolve(repo, values.root),
    values['baseline-graph'] ? resolve(repo, values['baseline-graph']) : undefined,
  );
  const output = resolve(repo, values.output);
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify(result, null, 2));
}
