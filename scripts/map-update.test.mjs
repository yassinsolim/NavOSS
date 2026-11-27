import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import {
  access,
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

// Runs the real infra/compose/map-update.sh against a stand-in artifact root, Geofabrik (curl),
// Proxmox API, Docker and fstrim. Linux only: the script needs GNU coreutils, flock and /proc.
const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const composeSource = join(repositoryRoot, 'infra/compose');
const linux =
  process.platform === 'linux' &&
  spawnSync('flock', ['--version']).status === 0 &&
  spawnSync('jq', ['--version']).status === 0;
const options = { skip: !linux && 'Linux with flock and jq is required' };
const LIVE = '261114';
const TOTAL = 1_000_000_000_000;

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function createFixture(context) {
  const directory = await mkdtemp(join(tmpdir(), 'navoss-map-update-'));
  context.after(() => rm(directory, { force: true, recursive: true }));
  const compose = join(directory, 'compose');
  const bin = join(directory, 'bin');
  const root = join(directory, 'artifacts');
  const imports = join(root, 'imports');
  const state = join(directory, 'state');
  const live = join(root, `valhalla-canada-${LIVE}-speeds-261127`);
  const previous = join(root, `valhalla-canada-${LIVE}`);
  const liveIndex = join(root, 'nominatim', `canada-${LIVE}`, 'postgres');
  const stale = [join(root, 'valhalla-canada-260901'), join(root, 'nominatim', 'canada-260901')];
  const marked = join(root, 'valhalla-canada-260801');
  for (const path of [compose, bin, imports, live, previous, liveIndex, marked, ...stale]) {
    await mkdir(path, { recursive: true });
  }
  for (const file of [
    'map-update.sh',
    'stage-coverage.sh',
    'check-stack.sh',
    'check-coverage.sh',
  ]) {
    await copyFile(join(composeSource, file), join(compose, file));
  }
  await writeFile(join(live, 'valhalla_tiles.tar'), 'graph');
  await writeFile(join(liveIndex, 'PG_VERSION'), '16');
  await writeFile(join(marked, '.navoss-keep'), '');
  for (const name of [
    `canada-${LIVE}.osm.pbf`,
    `canada-${LIVE}.routing.osm.pbf`,
    'canada-260901.osm.pbf',
  ]) {
    await writeFile(join(imports, name), 'extract');
  }
  await writeFile(join(imports, 'SHA256SUMS-canada-260901'), 'sums');
  await writeFile(
    join(compose, '.env'),
    [
      'NOMINATIM_PASSWORD=production-secret-value',
      `VALHALLA_DATA_DIR=${live}`,
      `NOMINATIM_DATA_DIR=${liveIndex}`,
      `NOMINATIM_PBF_PATH=${join(imports, `canada-${LIVE}.osm.pbf`)}`,
      'NOMINATIM_DATASET_VERSION=canada-geofabrik-2026-11-14',
      'COMMUNITY_TRAFFIC_MODE=collect',
      '',
    ].join('\n'),
  );
  await writeFile(
    join(compose, '.env.pre-speeds-20261127T082102Z'),
    `VALHALLA_DATA_DIR=${previous}\n`,
  );
  await writeFile(join(directory, 'meminfo'), 'MemAvailable:   20971520 kB\n');
  const fakes = {
    curl: `#!/bin/sh
for argument do
  case "$argument" in
    --write-out) printf '%s' "https://download.geofabrik.de/north-america/canada/canada-$FAKE_LATEST.osm.pbf"; exit 0 ;;
    *.md5) echo "0123456789abcdef0123456789abcdef  canada-$FAKE_LATEST.osm.pbf"; exit 0 ;;
  esac
done
exit 22
`,
    'pve-api': `#!/bin/sh
echo "$*" >>"$FAKE_CALLS"
printf '{"data":{"used":%s,"total":${TOTAL}}}' "$FAKE_POOL_USED"
`,
    docker: '#!/bin/sh\necho "docker $*" >>"$FAKE_CALLS"\nexit 0\n',
    fstrim: '#!/bin/sh\necho "fstrim $*" >>"$FAKE_CALLS"\n',
    sleep: '#!/bin/sh\nexit 0\n',
  };
  for (const [name, content] of Object.entries(fakes)) {
    await writeFile(join(bin, name), content);
    await chmod(join(bin, name), 0o755);
  }
  const calls = join(directory, 'calls');
  await writeFile(calls, '');
  const env = {
    ...process.env,
    FAKE_CALLS: calls,
    FAKE_LATEST: '261126',
    FAKE_POOL_USED: String(TOTAL / 2),
    MAP_UPDATE_MEMINFO: join(directory, 'meminfo'),
    MAP_UPDATE_PVE_API: join(bin, 'pve-api'),
    NAVOSS_ARTIFACT_ROOT: root,
    NAVOSS_MAP_UPDATE_STATE: state,
    PATH: `${bin}:${String(process.env.PATH)}`,
  };
  return { calls, compose, env, imports, live, liveIndex, marked, previous, root, stale, state };
}

function update(fixture, args, env = {}) {
  return spawnSync('sh', [join(fixture.compose, 'map-update.sh'), ...args], {
    encoding: 'utf8',
    env: { ...fixture.env, ...env },
    timeout: 60_000,
  });
}

async function status(fixture) {
  return JSON.parse(await readFile(join(fixture.state, 'status.json'), 'utf8'));
}

test('does nothing but prune when Geofabrik has no newer release', options, async (context) => {
  const fixture = await createFixture(context);
  const result = update(fixture, ['run'], { FAKE_LATEST: LIVE });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const record = await status(fixture);
  assert.equal(record.result, 'up-to-date');
  assert.equal(record.geofabrikLatest, LIVE);
  // The live graph and index, the rollback graph from the newest .env backup, and a build marked
  // by hand stay; another release's graph, index and extract go, and the pool gets them back.
  for (const kept of [fixture.live, fixture.previous, fixture.liveIndex, fixture.marked]) {
    assert.ok(await exists(kept), kept);
  }
  for (const removed of [...fixture.stale, join(fixture.imports, 'canada-260901.osm.pbf')]) {
    assert.equal(await exists(removed), false, removed);
  }
  assert.ok(await exists(join(fixture.imports, `canada-${LIVE}.routing.osm.pbf`)));
  assert.equal(
    await readFile(join(fixture.state, 'previous-valhalla'), 'utf8'),
    `${fixture.previous}\n`,
  );
  assert.match(await readFile(fixture.calls, 'utf8'), /^fstrim -v /mu);
  assert.doesNotMatch(await readFile(fixture.calls, 'utf8'), /pve-api|nodes/u);
});

test(
  'the storage gate refuses a build that would take the pool over its limit',
  options,
  async (context) => {
    const fixture = await createFixture(context);
    const result = update(fixture, ['run'], { FAKE_POOL_USED: String(TOTAL * 0.81) });
    assert.equal(result.status, 75, result.stdout + result.stderr);
    const record = await status(fixture);
    assert.equal(record.result, 'refused');
    assert.match(record.reason, /nvme-fast would reach 81\.00 % .*limit 78 %/u);
    // Nothing was staged.
    assert.equal(await exists(join(fixture.root, 'valhalla-canada-261126')), false);
    assert.equal(await exists(join(fixture.imports, 'canada.stage-version')), false);
    assert.match(result.stdout, /Refused: nvme-fast would reach/u);
  },
);

test(
  'the gate also refuses without memory for the build and the floor',
  options,
  async (context) => {
    const fixture = await createFixture(context);
    await writeFile(fixture.env.MAP_UPDATE_MEMINFO, 'MemAvailable:   8388608 kB\n');
    const result = update(fixture, ['run']);
    assert.equal(result.status, 75, result.stdout + result.stderr);
    assert.match(
      (await status(fixture)).reason,
      /memory available; graph needs 8 GiB \+ 4 GiB floor/u,
    );
  },
);

test(
  'plan reports the release, the gate and the steps without changing anything',
  options,
  async (context) => {
    const fixture = await createFixture(context);
    const before = await readFile(join(fixture.compose, '.env'), 'utf8');
    const refused = update(fixture, ['plan'], { FAKE_POOL_USED: String(TOTAL * 0.81) });
    assert.equal(refused.status, 0, refused.stdout + refused.stderr);
    assert.match(refused.stdout, /Geofabrik Canada: 261126/u);
    assert.match(refused.stdout, /A run now would be refused: nvme-fast/u);
    assert.match(refused.stdout, /Plan for canada-261126 \(once the gate passes\)/u);
    assert.match(refused.stdout, /would remove .*valhalla-canada-260901/u);
    const planned = update(fixture, ['plan']);
    assert.match(planned.stdout, /2\. stage-coverage\.sh valhalla canada/u);
    // The index is 12 days old, under the 28-day cadence.
    assert.match(planned.stdout, /index not due \(12 of 28 days\)/u);
    assert.match(planned.stdout, /swap valhalla api/u);
    for (const kept of fixture.stale) assert.ok(await exists(kept), kept);
    assert.equal(await exists(join(fixture.state, 'status.json')), false);
    assert.equal(await readFile(join(fixture.compose, '.env'), 'utf8'), before);
  },
);

test('a staging step holding the lock refuses the run', options, async (context) => {
  const fixture = await createFixture(context);
  const lock = join(fixture.root, '.stage.lock');
  const holder = spawn('flock', [lock, 'sleep', '30']);
  context.after(() => holder.kill());
  await new Promise((resolve) => setTimeout(resolve, 300));
  const result = update(fixture, ['run']);
  assert.equal(result.status, 75, result.stdout + result.stderr);
  assert.match((await status(fixture)).reason, /a staging step holds/u);
});

test(
  'stage-coverage.sh steps run under the lock the updater passes them',
  options,
  async (context) => {
    const fixture = await createFixture(context);
    const lock = join(fixture.root, '.stage.lock');
    const script = join(fixture.compose, 'stage-coverage.sh');
    const run = (inherit) =>
      spawnSync(
        'sh',
        [
          '-c',
          `exec 9>>"$1"; flock -n 9 || exit 99; ${inherit ? 'STAGE_LOCK_INHERITED=1 ' : ''}STAGE_HOLDER_WAIT=0 sh "$2" stop canada`,
          'sh',
          lock,
          script,
        ],
        { encoding: 'utf8', env: fixture.env, timeout: 30_000 },
      );
    const inherited = run(true);
    assert.equal(inherited.status, 0, inherited.stdout + inherited.stderr);
    assert.match(inherited.stdout, /Staging containers removed/u);
    // Without the hand-over the same step is locked out by its own parent.
    const separate = run(false);
    assert.notEqual(separate.status, 0);
    assert.match(separate.stderr, /cannot be verified/u);
  },
);

test('the traffic overlay graph is never replaced', options, async (context) => {
  const fixture = await createFixture(context);
  await writeFile(
    join(fixture.compose, '.env'),
    `${await readFile(join(fixture.compose, '.env'), 'utf8')}COMMUNITY_TRAFFIC_GRAPH_ID=${'a'.repeat(64)}\n`,
  );
  const result = update(fixture, ['run']);
  assert.equal(result.status, 75, result.stdout + result.stderr);
  assert.match((await status(fixture)).reason, /COMMUNITY_TRAFFIC_GRAPH_ID is set/u);
});

test(
  'a rollback restores only the data values, never an older secret',
  options,
  async (context) => {
    const fixture = await createFixture(context);
    const envFile = join(fixture.compose, '.env');
    const original = await readFile(envFile, 'utf8');
    // Back to the previous graph; the stand-in stack fails every check, so the swap is undone too.
    const result = update(fixture, ['rollback', 'valhalla']);
    assert.equal(result.status, 2, result.stdout + result.stderr);
    assert.equal((await status(fixture)).result, 'rollback-failed');
    assert.equal(await readFile(envFile, 'utf8'), original);
    const backups = (await readdir(fixture.compose)).filter((name) =>
      name.startsWith('.env.pre-map-update-'),
    );
    assert.equal(backups.length, 1);
    const backup = await readFile(join(fixture.compose, backups[0]), 'utf8');
    assert.equal(
      backup,
      [
        `VALHALLA_DATA_DIR=${fixture.live}`,
        `NOMINATIM_DATA_DIR=${fixture.liveIndex}`,
        `NOMINATIM_PBF_PATH=${join(fixture.imports, `canada-${LIVE}.osm.pbf`)}`,
        'NOMINATIM_DATASET_VERSION=canada-geofabrik-2026-11-14',
        '',
      ].join('\n'),
    );
    assert.doesNotMatch(backup, /PASSWORD/u);
    assert.equal((await stat(join(fixture.compose, backups[0]))).mode & 0o777, 0o600);
  },
);
