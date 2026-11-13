import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmod,
  link,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs, promisify } from 'node:util';
import { userInfo } from 'node:os';

import {
  createManifest,
  type ArtifactInfo,
  type BuiltRegion,
  type BuiltResources,
  type GraphIdentity,
} from './manifest.mjs';
import { routingEnginePin } from './engine.mjs';
import { buildResources, searchNormalization } from './resources.mjs';
import {
  inspectArtifact,
  readMapMetadata,
  readRegionCatalog,
  sha256File,
  writeRegion,
} from './tools.mjs';

const exec = promisify(execFile);
const scripts = dirname(fileURLToPath(import.meta.url));
const repo = resolve(scripts, '../..');
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

interface Measurement {
  stage: string;
  seconds: number;
  cached: boolean;
}
interface CacheRecord {
  key: string;
  files: Record<string, ArtifactInfo>;
  maps?: BuiltRegion['maps'];
  unpackedByteSize?: number;
}

export function parseBuildOptions(args: string[]) {
  const { values } = parseArgs({
    args,
    options: {
      date: { type: 'string' },
      regions: { type: 'string', default: 'calgary' },
      'base-url': { type: 'string' },
      'routing-engine-version': {
        type: 'string',
        default: routingEnginePin().routingEngineVersion,
      },
      output: { type: 'string', default: 'artifacts/offline' },
      help: { type: 'boolean', default: false },
      'list-regions': { type: 'boolean', default: false },
    },
  });
  if (values.help || values['list-regions']) return { ...values, dataDate: '' };
  routingEnginePin(values['routing-engine-version']);
  if (!values.date || !/^\d{6}$/.test(values.date))
    throw new Error('--date must be a dated Geofabrik YYMMDD release');
  const dataDate = `20${values.date.slice(0, 2)}-${values.date.slice(2, 4)}-${values.date.slice(4, 6)}`;
  const parsedDate = new Date(`${dataDate}T00:00:00Z`);
  if (!Number.isFinite(parsedDate.getTime()) || parsedDate.toISOString().slice(0, 10) !== dataDate)
    throw new Error('Invalid extract date');
  if (!values['base-url'])
    throw new Error('--base-url must point at the static releases directory');
  const url = new URL(values['base-url']);
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (
    (url.protocol !== 'https:' && !(local && url.protocol === 'http:')) ||
    url.search ||
    url.hash ||
    url.username ||
    url.password
  ) {
    throw new Error('Static hosting requires HTTPS; loopback HTTP is allowed for verification');
  }
  return { ...values, dataDate };
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

async function readCache(directory: string, key: string): Promise<CacheRecord | undefined> {
  const marker = join(directory, 'complete.json');
  if (!(await exists(marker))) return undefined;
  const record = JSON.parse(await readFile(marker, 'utf8')) as CacheRecord;
  if (record.key !== key || !record.files || Object.keys(record.files).length === 0)
    throw new Error('Invalid build cache identity');
  for (const [name, expected] of Object.entries(record.files)) {
    if (!/^[a-z0-9][a-z0-9._-]*$/.test(name)) throw new Error('Invalid cache member name');
    const actual = await inspectArtifact(join(directory, name));
    if (actual.byteSize !== expected.byteSize || actual.sha256 !== expected.sha256)
      throw new Error(`Corrupt cached artifact: ${name}`);
  }
  return record;
}

export async function build(args: string[]): Promise<void> {
  const options = parseBuildOptions(args);
  const catalog = await readRegionCatalog(join(scripts, 'regions/regions.geojson'));
  if (options.help) {
    console.log(
      'Usage: ./infra/offline/build.sh --date YYMMDD --regions calgary[,alberta,...]|all --base-url HTTPS_URL [--output DIRECTORY]\nRequires Docker, Node 24 and pnpm install --frozen-lockfile. See infra/offline/README.md.',
    );
    return;
  }
  if (options['list-regions']) {
    console.log(
      catalog.map((region) => `${region.properties.id}\t${region.properties.name}`).join('\n'),
    );
    return;
  }
  if (process.versions.node.split('.')[0] !== '24')
    throw new Error('Use the repository-pinned Node 24 toolchain');
  const selected =
    options.regions === 'all'
      ? catalog.filter((region) => !region.properties.bulk)
      : options.regions.split(',').map((id) => {
          const region = catalog.find((candidate) => candidate.properties.id === id);
          if (!region) throw new Error(`Unknown download region: ${id}`);
          return region;
        });
  if (new Set(selected.map((region) => region.properties.id)).size !== selected.length)
    throw new Error('Duplicate region selection');
  const output = resolve(repo, options.output);
  await mkdir(output, { recursive: true });
  const lock = join(output, '.build-lock');
  try {
    await mkdir(lock);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST')
      throw new Error(`A build lock exists at ${lock}; do not run concurrent builds in one cache`);
    throw error;
  }
  const measurements: Measurement[] = [];
  const started = performance.now();
  const runId = `${options.date}-${process.pid}`;
  const logDirectory = join(output, 'logs', runId);
  await mkdir(logDirectory, { recursive: true });
  await writeFile(
    join(lock, 'owner.json'),
    JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }) + '\n',
  );
  async function command(
    program: string,
    args: string[],
    label: string,
    env = process.env,
  ): Promise<string> {
    const start = performance.now();
    console.log(`Building ${label}`);
    let stdout = '';
    let stderr = '';
    try {
      const result = await exec(program, args, { cwd: repo, env, maxBuffer: 32 * 1024 * 1024 });
      stdout = result.stdout;
      stderr = result.stderr;
      return stdout;
    } catch (error) {
      const failure = error as Error & { stdout?: string; stderr?: string; code?: string | number };
      stdout = failure.stdout ?? '';
      stderr = failure.stderr ?? failure.message;
      throw new Error(
        `${label} failed (${failure.code ?? failure.name}); see ${join(logDirectory, `${label}.log`)}`,
      );
    } finally {
      await writeFile(join(logDirectory, `${label}.log`), stdout + stderr);
      measurements.push({
        stage: label,
        seconds: Math.round((performance.now() - start) * 1000) / 1_000_000,
        cached: false,
      });
      if (stderr) process.stderr.write(stderr);
    }
  }
  try {
    const dockerfileHash = await sha256File(join(scripts, 'Dockerfile'));
    const engine = routingEnginePin(options['routing-engine-version']);
    const imageKey = digest({ dockerfileHash, engine });
    const image = `navoss-offline-builder:${imageKey.slice(0, 12)}`;
    if (
      !(await exec('docker', ['image', 'inspect', image]).then(
        () => true,
        (error: NodeJS.ErrnoException) => {
          if (error.code === 'ENOENT') throw new Error('Docker is required');
          return false;
        },
      ))
    )
      await command(
        'docker',
        [
          'build',
          '--progress=plain',
          '--build-arg',
          `VALHALLA_IMAGE=${engine.image}`,
          '-t',
          image,
          '-f',
          join(scripts, 'Dockerfile'),
          scripts,
        ],
        'builder-image',
      );
    const { uid, gid } = userInfo();
    const common = [
      'run',
      '--rm',
      '--hostname',
      'navoss-offline',
      '--add-host',
      'navoss-offline:127.0.0.1',
      '--user',
      `${uid}:${gid}`,
      '--volume',
      `${output}:/work`,
      '--volume',
      `${scripts}:/scripts:ro`,
      '--env',
      'HOME=/tmp',
    ];
    const containerPath = (path: string) => '/work/' + path.slice(output.length + 1);
    async function docker(
      label: string,
      args: string[],
      settings: { cpus?: number; memory?: string; network?: boolean; volumes?: string[] } = {},
    ) {
      const volumes = (settings.volumes ?? []).flatMap((volume) => ['--volume', volume]);
      return command(
        'docker',
        [
          ...common,
          '--name',
          `offline-bundles-${label}-${process.pid}`,
          '--cpus',
          String(settings.cpus ?? 2),
          '--memory',
          settings.memory ?? '3g',
          '--network',
          settings.network ? 'bridge' : 'none',
          ...volumes,
          image,
          ...args,
        ],
        label,
      );
    }
    const actualEngineVersion = (
      await docker('routing-engine-version', ['valhalla_build_tiles', '--version'], {
        memory: '512m',
      })
    ).trim();
    if (actualEngineVersion !== engine.routingEngineVersion)
      throw new Error('Builder engine differs from the pinned mobile wrapper');
    const sources = join(output, 'sources');
    const mirror = process.env.NAVOSS_OFFLINE_SOURCE_MIRROR;
    const sourceArgs = mirror
      ? ['env', `NAVOSS_OFFLINE_SOURCE_MIRROR=${mirror}`, 'bash']
      : ['bash'];
    await docker(
      'sources',
      [...sourceArgs, '/scripts/prepare-sources.sh', '/scripts/sources.lock.json', '/work/sources'],
      { network: true },
    );
    const inputs = join(output, 'inputs', options.date!);
    await docker(
      'inputs',
      ['bash', '/scripts/prepare-inputs.sh', options.date!, containerPath(inputs)],
      { network: true },
    );
    const data = JSON.parse(await readFile(join(inputs, 'data.json'), 'utf8')) as {
      dataDate: string;
      osmTimestamp: string;
    };
    if (data.dataDate !== options.dataDate)
      throw new Error('Input date disagrees with requested release');
    const epoch = Math.floor(Date.parse(data.osmTimestamp) / 1000);
    const pbf = containerPath(join(inputs, `alberta-british-columbia-${options.date}.osm.pbf`));
    const inputSums = await readFile(join(inputs, 'SHA256SUMS'), 'utf8');
    const sourceLock = await sha256File(join(scripts, 'sources.lock.json'));
    const graphKey = digest({
      inputs: inputSums,
      dockerfileHash,
      engine,
      sourceLock,
      scripts: await Promise.all([
        sha256File(join(scripts, 'build-graph.sh')),
        sha256File(join(scripts, 'assemble-routing.py')),
        sha256File(join(repo, 'infra/compose/prepare-valhalla-speeds.sh')),
        sha256File(join(repo, 'infra/compose/repair-valhalla-admins.sh')),
      ]),
    });
    const graphDirectory = join(output, 'graphs', graphKey);
    let graphCache = await readCache(graphDirectory, graphKey);
    if (!graphCache) {
      await mkdir(join(output, '.work'), { recursive: true });
      const stage = await mkdtemp(join(output, '.work/graph-'));
      await command(
        join(repo, 'infra/compose/prepare-valhalla-speeds.sh'),
        [stage],
        'static-speeds',
      );
      const graphMount = [`${stage}:/graph`];
      await docker(
        'graph-admins-timezones',
        ['bash', '/scripts/build-graph.sh', 'prepare', '/graph', pbf, '/work/sources'],
        { volumes: graphMount },
      );
      await command(
        join(repo, 'infra/compose/repair-valhalla-admins.sh'),
        [stage],
        'graph-country-parent',
        { ...process.env, VALHALLA_IMAGE: engine.image },
      );
      await docker(
        'graph-build',
        ['bash', '/scripts/build-graph.sh', 'build', '/graph', pbf, '/work/sources'],
        { volumes: graphMount },
      );
      await docker(
        'graph-canonicalize',
        [
          'python3',
          '/scripts/assemble-routing.py',
          '--canonicalize',
          '--epoch',
          String(epoch),
          '--output',
          '/graph/connected.tar',
          '/graph/valhalla_tiles.tar',
        ],
        { volumes: graphMount },
      );
      const file = await inspectArtifact(join(stage, 'connected.tar'));
      const graph: GraphIdentity = {
        graphId: file.sha256,
        routingEngineVersion: engine.routingEngineVersion,
        tileFormat: engine.tileFormat,
        tileFormatVersion: engine.tileFormatVersion,
        dataDate: data.dataDate,
        speedProfileSha256: await sha256File(join(stage, 'default_speeds.json')),
      };
      await writeFile(join(stage, 'graph.json'), JSON.stringify(graph) + '\n');
      graphCache = { key: graphKey, files: { 'connected.tar': file } };
      await writeFile(join(stage, 'complete.json'), JSON.stringify(graphCache) + '\n');
      await mkdir(dirname(graphDirectory), { recursive: true });
      await rename(stage, graphDirectory);
    } else measurements.push({ stage: 'graph', seconds: 0, cached: true });
    const graph = JSON.parse(
      await readFile(join(graphDirectory, 'graph.json'), 'utf8'),
    ) as GraphIdentity;
    if (
      graph.graphId !== graphCache.files['connected.tar']?.sha256 ||
      graph.dataDate !== data.dataDate ||
      graph.routingEngineVersion !== engine.routingEngineVersion ||
      graph.tileFormatVersion !== engine.tileFormatVersion ||
      graph.tileFormat !== engine.tileFormat
    )
      throw new Error('Invalid connected graph metadata');
    const resourceKey = digest({
      sourceLock,
      dockerfileHash,
      normalization: searchNormalization(),
      graphConfig: await sha256File(join(graphDirectory, 'valhalla.json')),
      code: await Promise.all(
        [
          'resources.mts',
          'tools.mts',
          'search-schema.sql',
          'search-query.sql',
          'category-query.sql',
        ].map((name) => sha256File(join(scripts, name))),
      ),
    });
    const resourceDirectory = join(output, 'shared', resourceKey);
    let resourceCache = await readCache(resourceDirectory, resourceKey);
    if (!resourceCache) {
      const stage = await mkdtemp(join(output, '.work/resources-'));
      const start = performance.now();
      const unpackedByteSize = await buildResources(
        sources,
        stage,
        scripts,
        join(graphDirectory, 'valhalla.json'),
      );
      measurements.push({
        stage: 'resources-copy',
        seconds: Math.round((performance.now() - start) * 1000) / 1_000_000,
        cached: false,
      });
      await docker('resources-pack', [
        'bash',
        '-c',
        'tar --sort=name --format=ustar --mtime="@$2" --owner=0 --group=0 --numeric-owner -C "$1/resources" -cf "$1/resources.tar" . && gzip -n -9 "$1/resources.tar"',
        'pack-resources',
        containerPath(stage),
        String(epoch),
      ]);
      resourceCache = {
        key: resourceKey,
        files: { 'resources.tar.gz': await inspectArtifact(join(stage, 'resources.tar.gz')) },
        unpackedByteSize,
      };
      await writeFile(join(stage, 'complete.json'), JSON.stringify(resourceCache) + '\n');
      await rm(join(stage, 'source-styles'), { recursive: true });
      await rm(join(stage, 'source-fonts'), { recursive: true });
      await mkdir(dirname(resourceDirectory), { recursive: true });
      await rename(stage, resourceDirectory);
    } else measurements.push({ stage: 'resources', seconds: 0, cached: true });
    if (!resourceCache.files['resources.tar.gz'] || !resourceCache.unpackedByteSize)
      throw new Error('Invalid resource cache');
    const resources: BuiltResources = {
      key: resourceKey,
      directory: resourceDirectory,
      file: resourceCache.files['resources.tar.gz'],
      unpackedByteSize: resourceCache.unpackedByteSize,
    };
    const regionCode = await Promise.all(
      ['build.mts', 'build-search.py', 'assemble-routing.py', 'tools.mts', 'search-schema.sql'].map(
        (name) => sha256File(join(scripts, name)),
      ),
    );
    const categoryFile = join(repo, 'infra/compose/nominatim-special-phrases.csv');
    const categoryHash = await sha256File(categoryFile);
    const builtRegions: BuiltRegion[] = [];
    for (const feature of selected) {
      const id = feature.properties.id;
      const key = digest({
        feature,
        regionCode,
        sourceLock,
        dockerfileHash,
        categoryHash,
        normalization: searchNormalization(),
        graph: graph.graphId,
        maxZoom: 14,
      });
      const directory = join(output, 'regions', key);
      let cache = await readCache(directory, key);
      if (!cache) {
        const stage = await mkdtemp(join(output, `.work/${id}-`));
        await writeRegion(feature, stage);
        const regionPath = containerPath(stage);
        await docker(
          `${id}-extract`,
          [
            'osmium',
            'extract',
            '--polygon',
            `${regionPath}/region.geojson`,
            '--strategy',
            'smart',
            '--option',
            'types=multipolygon',
            '--set-bounds',
            '--output-header',
            `osmosis_replication_timestamp=${data.osmTimestamp}`,
            '--output',
            `${regionPath}/region.osm.pbf`,
            pbf,
          ],
          { memory: '2g' },
        );
        await docker(
          `${id}-maps`,
          [
            'java',
            '-Xmx4g',
            '-jar',
            '/opt/planetiler.jar',
            `--osm-path=${regionPath}/region.osm.pbf`,
            `--output=${regionPath}/maps.pmtiles`,
            '--download-dir=/work/sources',
            `--tmpdir=${regionPath}/tmp`,
            `--polygon=${regionPath}/region.poly`,
            '--threads=6',
            '--maxzoom=14',
            '--tile-weights=/dev/null',
            '--use-wikidata=false',
          ],
          { cpus: 6, memory: '6g' },
        );
        const { schemaVersion, minZoom, maxZoom } = await readMapMetadata(
          join(stage, 'maps.pmtiles'),
        );
        const maps = { schemaVersion, minZoom, maxZoom };
        await docker(
          `${id}-routing-select`,
          [
            'valhalla_build_extract',
            '-c',
            '/graph/valhalla.json',
            '-e',
            `${regionPath}/routing.raw.tar`,
            '-g',
            regionPath,
            '-v',
          ],
          { volumes: [`${graphDirectory}:/graph:ro`] },
        );
        await docker(
          `${id}-routing-pack`,
          [
            'python3',
            '/scripts/assemble-routing.py',
            '--epoch',
            String(epoch),
            '--metadata',
            '/graph/graph.json',
            '--output',
            `${regionPath}/routing.tar`,
            `${regionPath}/routing.raw.tar`,
          ],
          { volumes: [`${graphDirectory}:/graph:ro`] },
        );
        const searchOutput = await docker(
          `${id}-search`,
          [
            'python3',
            '/scripts/build-search.py',
            '--pbf',
            `${regionPath}/region.osm.pbf`,
            '--output',
            `${regionPath}/search.sqlite`,
            '--region',
            `${regionPath}/region.geojson`,
            '--schema',
            '/scripts/search-schema.sql',
            '--categories',
            '/categories.csv',
            '--normalization',
            `${containerPath(resourceDirectory)}/resources/search-normalization.json`,
            '--data',
            `${containerPath(inputs)}/data.json`,
          ],
          { volumes: [`${categoryFile}:/categories.csv:ro`] },
        );
        await writeFile(join(stage, 'search-counts.json'), searchOutput);
        cache = {
          key,
          files: Object.fromEntries(
            await Promise.all(
              ['maps.pmtiles', 'routing.tar', 'search.sqlite'].map(async (name) => [
                name,
                await inspectArtifact(join(stage, name)),
              ]),
            ),
          ),
          maps,
        };
        await writeFile(join(stage, 'complete.json'), JSON.stringify(cache) + '\n');
        await rm(join(stage, 'tmp'), { recursive: true, force: true });
        await rm(join(stage, 'routing.raw.tar'));
        await mkdir(dirname(directory), { recursive: true });
        await rename(stage, directory);
      } else measurements.push({ stage: id, seconds: 0, cached: true });
      if (
        !cache.maps ||
        !cache.files['maps.pmtiles'] ||
        !cache.files['routing.tar'] ||
        !cache.files['search.sqlite']
      )
        throw new Error('Incomplete region cache');
      builtRegions.push({
        feature,
        key,
        directory,
        maps: cache.maps,
        files: {
          'maps.pmtiles': cache.files['maps.pmtiles'],
          'routing.tar': cache.files['routing.tar'],
          'search.sqlite': cache.files['search.sqlite'],
        },
      });
    }
    const manifest = createManifest(
      options['base-url']!,
      data,
      graph,
      builtRegions,
      resources,
      new Date().toISOString(),
    );
    const release = join(output, 'releases', manifest.bundleVersion);
    if (!(await exists(release))) {
      const stage = await mkdtemp(join(output, '.work/release-'));
      for (const region of builtRegions) {
        const regionDirectory = join(stage, 'regions', region.feature.properties.id);
        await mkdir(regionDirectory, { recursive: true });
        for (const name of Object.keys(region.files)) {
          await link(join(region.directory, name), join(regionDirectory, name));
          await chmod(join(regionDirectory, name), 0o444);
        }
      }
      await link(join(resources.directory, 'resources.tar.gz'), join(stage, 'resources.tar.gz'));
      await chmod(join(stage, 'resources.tar.gz'), 0o444);
      await writeFile(join(stage, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
      const dockerInfo = JSON.parse(
        (await exec('docker', ['info', '--format', '{{json .}}'])).stdout,
      ) as { NCPU: number; MemTotal: number; Architecture: string };
      await writeFile(
        join(stage, 'build-report.json'),
        JSON.stringify(
          {
            data,
            bundleVersion: manifest.bundleVersion,
            elapsedSeconds: Math.round((performance.now() - started) * 1000) / 1_000_000,
            measurements,
            docker: {
              cpus: dockerInfo.NCPU,
              memoryBytes: dockerInfo.MemTotal,
              architecture: dockerInfo.Architecture,
            },
            buildLimits: {
              maps: { cpus: 6, memoryBytes: 6 * 1024 ** 3, javaHeapBytes: 4 * 1024 ** 3 },
              routing: { cpus: 2, memoryBytes: 3 * 1024 ** 3 },
            },
            caches: {
              graph: relative(output, graphDirectory),
              resources: relative(output, resources.directory),
              regions: builtRegions.map((region) => ({
                id: region.feature.properties.id,
                directory: relative(output, region.directory),
              })),
            },
          },
          null,
          2,
        ) + '\n',
      );
      await writeFile(
        join(stage, 'provenance.json'),
        JSON.stringify(
          {
            data,
            inputChecksums: inputSums,
            sourceLock: JSON.parse(await readFile(join(scripts, 'sources.lock.json'), 'utf8')),
            builderDockerfileSha256: dockerfileHash,
            routingEngine: engine,
            graph,
            regionDefinitions: selected,
            categoryMappingSha256: categoryHash,
          },
          null,
          2,
        ) + '\n',
      );
      const sums = builtRegions.flatMap((region) =>
        Object.entries(region.files).map(
          ([name, file]) => `${file.sha256}  regions/${region.feature.properties.id}/${name}`,
        ),
      );
      sums.push(`${resources.file.sha256}  resources.tar.gz`);
      await writeFile(join(stage, 'SHA256SUMS'), sums.join('\n') + '\n');
      await mkdir(dirname(release), { recursive: true });
      await rename(stage, release);
    }
    // Never advertise a partial release. Artifacts are immutable; only the manifest pointer changes.
    await writeFile(join(output, 'manifest.json.next'), JSON.stringify(manifest, null, 2) + '\n');
    await rename(join(output, 'manifest.json.next'), join(output, 'manifest.json'));
    console.log(
      `Offline bundle complete: ${manifest.bundleVersion}\nManifest: ${join(output, 'manifest.json')}\nStatic root: ${join(output, 'releases')}`,
    );
  } finally {
    await rm(lock, { recursive: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  build(process.argv.slice(2)).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : 'Offline build failed');
    process.exitCode = 1;
  });
}
