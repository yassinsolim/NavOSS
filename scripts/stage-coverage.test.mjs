import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import {
  access,
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

// Runs the real infra/compose/stage-coverage.sh (copied beside a stand-in `.env`) against a
// stand-in `docker` that keeps container state in files and logs every call, and a `curl` that
// answers every health probe. Linux only: the script needs flock and setsid (util-linux).
const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const composeSource = join(repositoryRoot, 'infra/compose');
const linux =
  spawnSync('flock', ['--version']).status === 0 && spawnSync('setsid', ['--version']).status === 0;
const options = { skip: !linux && 'flock and setsid (util-linux) are required' };
const VERSION = '261114';

// Upstream mediagis/nominatim:5.3 heads: both trace every command, which prints the password.
const UPSTREAM = {
  'init.sh': `#!/bin/bash -ex
# temporarily enable unsafe import optimization config
cp /etc/postgresql/16/main/conf.d/postgres-import.conf.disabled /etc/postgresql/16/main/conf.d/postgres-import.conf
sudo -E -u postgres psql postgres -tAc "ALTER USER nominatim WITH ENCRYPTED PASSWORD '$NOMINATIM_PASSWORD'"
if [ "$REVERSE_ONLY" = "true" ]; then
  sudo -E -u nominatim nominatim import --osm-file $OSMFILE --threads $THREADS --reverse-only
else
  sudo -E -u nominatim nominatim import --osm-file $OSMFILE --threads $THREADS
fi
`,
  'start.sh': `#!/bin/bash -ex
useradd -m -p \${NOMINATIM_PASSWORD} nominatim
`,
};

const fakeDocker = `#!/bin/sh
# State: $FAKE_STATE/created/<name> holds the create/run arguments, one per line;
# $FAKE_STATE/running/<name> marks a running container; files/<name>/<path> what was copied in.
# Docker's daemon state is shared independently of the caller's uid.
umask 000
state=$FAKE_STATE
mkdir -p "$state/created" "$state/running" "$state/files"
printf '%s\\n' "$*" >>"$state/calls"
command=$1
shift
case "$command" in
  ps)
    for name in $(ls "$state/running"); do
      printf '%s %s\\n' "$name" "$(cat "$state/labels/$name" 2>/dev/null)"
    done
    ;;
  inspect)
    for name do :; done
    [ -e "$state/created/$name" ] || exit 1
    if [ -e "$state/running/$name" ]; then echo true; else echo false; fi
    ;;
  rm)
    for name do
      [ "$name" = -f ] && continue
      rm -f "$state/created/$name" "$state/running/$name"
      rm -rf "$state/files/$name"
    done
    ;;
  stop) rm -f "$state/running/$1" ;;
  start) [ -e "$state/created/$1" ] || exit 1; touch "$state/running/$1" ;;
  create | run)
    name=
    detach=
    remove=
    previous=
    for argument do
      [ "$previous" = --name ] && name=$argument
      [ "$argument" = -d ] && detach=1
      [ "$argument" = --rm ] && remove=1
      previous=$argument
    done
    if [ -n "$remove" ]; then
      case " $* " in
        *" --entrypoint spatialite "*) echo 9 ;;
        *" --entrypoint rm "*)
          # A root container: removes what it was given inside its single mount.
          mount=
          previous=
          for argument do
            [ "$previous" = -v ] && mount=$argument
            if [ "$previous" = --mount ]; then
              src=$(printf '%s' "$argument" | sed -n 's/.*src=\\([^,]*\\).*/\\1/p')
              dst=$(printf '%s' "$argument" | sed -n 's/.*dst=\\([^,]*\\).*/\\1/p')
              mount=$src:$dst
            fi
            previous=$argument
          done
          host=\${mount%%:*}
          inside=\${mount#*:}
          for target do
            case "$target" in "$inside"/*) ;; *) continue ;; esac
            path=$host\${target#"$inside"}
            chmod -R u+rwx "$path" 2>/dev/null
            rm -rf "$path"
          done
          ;;
      esac
      exit 0
    fi
    for argument do printf '%s\\n' "$argument"; done >"$state/created/$name"
    mkdir -p "$state/labels"
    sed -n '/^--label$/{n;s/^navoss.stage.step=//p;}' "$state/created/$name" >"$state/labels/$name"
    rm -f "$state/running/$name"
    [ -n "$detach" ] && touch "$state/running/$name"
    exit 0
    ;;
  cp)
    case "$1" in
      *:*)
        # Holds the step here while $state/hold exists: a running heavy step with no container up.
        if [ -e "$state/hold" ]; then
          touch "$state/holding"
          while [ -e "$state/hold" ]; do sleep 0.1; done
        fi
        printf '%s' "$(cat "$FAKE_UPSTREAM/\${1##*/}")" >"$2"
        printf '\\n' >>"$2"
        ;;
      *)
        mkdir -p "$state/files/\${2%%:*}"
        cp "$1" "$state/files/\${2%%:*}/\${2##*/}"
        chmod 0666 "$state/files/\${2%%:*}/\${2##*/}"
        ;;
    esac
    ;;
  version) echo "\${FAKE_DOCKER_VERSION:-27.3.1}" ;;
  network | update | logs) exit 0 ;;
  *) echo "fake docker: unexpected $command" >&2; exit 64 ;;
esac
`;

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/** A staging root with inputs for `labels`, a copy of the compose scripts and the fakes. */
async function createFixture(context, labels = ['new-brunswick']) {
  const directory = await mkdtemp(join(tmpdir(), 'navoss-stage-coverage-'));
  context.after(async () => {
    // Mixed-user tests can leave postgres data and fake container state owned by root.
    spawnSync('chmod', ['-R', 'u+rwx', directory]);
    try {
      await rm(directory, { force: true, recursive: true });
    } catch {
      const cleanup = spawnSync('sudo', ['-n', 'rm', '-rf', '--', directory]);
      if (cleanup.status !== 0) console.error(`Could not clean fixture ${directory}`);
    }
  });
  const compose = join(directory, 'compose');
  const bin = join(directory, 'bin');
  const root = join(directory, 'artifacts');
  const upstream = join(directory, 'upstream');
  const state = join(directory, 'docker');
  const live = join(root, 'nominatim', 'live', 'postgres');
  const liveValhalla = join(root, 'valhalla-live');
  for (const path of [compose, bin, join(root, 'imports'), upstream, state, live, liveValhalla]) {
    await mkdir(path, { recursive: true });
  }
  // The fake daemon must accept Docker calls from both users, regardless of who started it.
  await chmod(state, 0o777);
  for (const file of await readdir(composeSource)) {
    if (file.endsWith('.sh')) await copyFile(join(composeSource, file), join(compose, file));
  }
  await writeFile(
    join(compose, '.env'),
    `NOMINATIM_PASSWORD=production-secret-value\nNOMINATIM_DATA_DIR=${live}\nVALHALLA_DATA_DIR=${join(root, 'valhalla-live')}\n`,
  );
  for (const label of labels) {
    await writeFile(join(root, 'imports', `${label}.stage-version`), `${VERSION}\n`);
    await writeFile(join(root, 'imports', `${label}-${VERSION}.osm.pbf`), `extract ${label}`);
  }
  for (const [name, content] of Object.entries(UPSTREAM)) {
    await writeFile(join(upstream, name), content);
  }
  await writeFile(join(bin, 'docker'), fakeDocker);
  await writeFile(join(bin, 'curl'), '#!/bin/sh\nexit 0\n');
  await chmod(join(bin, 'docker'), 0o755);
  await chmod(join(bin, 'curl'), 0o755);
  const env = {
    ...process.env,
    FAKE_STATE: state,
    FAKE_UPSTREAM: upstream,
    GEOFABRIK_VERSION: VERSION,
    NAVOSS_ARTIFACT_ROOT: root,
    PATH: `${bin}:${String(process.env.PATH)}`,
    STAGE_MIN_FREE_GB: '0',
  };
  return { compose, directory, env, live, liveValhalla, root, state };
}

function stage(fixture, args, env = {}) {
  return spawnSync('sh', [join(fixture.compose, 'stage-coverage.sh'), ...args], {
    encoding: 'utf8',
    env: { ...fixture.env, ...env },
    timeout: 30_000,
  });
}

// Exercise the same transition on CI's sudo-enabled Linux runner and in a root-run Linux container.
function stageAs(fixture, args, asRoot) {
  const script = join(fixture.compose, 'stage-coverage.sh');
  if (process.getuid() === 0) {
    return spawnSync('sh', [script, ...args], {
      encoding: 'utf8',
      env: fixture.env,
      ...(asRoot ? {} : { uid: 65534, gid: 65534 }),
      timeout: 30_000,
    });
  }
  if (!asRoot) return stage(fixture, args);
  const vars = Object.entries(fixture.env).map(([key, value]) => `${key}=${value}`);
  return spawnSync('sudo', ['-n', 'env', ...vars, 'sh', script, ...args], {
    encoding: 'utf8',
    timeout: 30_000,
  });
}

async function mixedFixture(context) {
  const fixture = await createFixture(context);
  if (process.getuid() === 0) {
    assert.equal(spawnSync('chown', ['-R', '65534:65534', fixture.directory]).status, 0);
  }
  return fixture;
}

async function fakeBuildHelpers(fixture) {
  const scripts = {
    'prepare-regional-pbf.sh': `#!/bin/sh
echo "${VERSION}"
`,
    'filter-routing-pbf.sh': `#!/bin/sh
cp "$1" "\${1%.osm.pbf}.routing.osm.pbf"
`,
    'prepare-valhalla-speeds.sh': `#!/bin/sh
echo speeds >"$1/default_speeds.json"
echo provenance >"$1/default_speeds.provenance"
`,
    'repair-valhalla-admins.sh': `#!/bin/sh
echo admins >"$1/admins.sqlite"
`,
  };
  for (const [name, content] of Object.entries(scripts)) {
    await writeFile(join(fixture.compose, name), content);
  }
  await writeFile(join(fixture.liveValhalla, 'timezones.sqlite'), 'zones');
}

test('a mixed-user root import stays resumable', options, async (context) => {
  const fixture = await mixedFixture(context);
  await fakeBuildHelpers(fixture);
  // Fake the files the graph container produces; the real parent script still makes its markers.
  const docker = join(fixture.env.PATH.split(':')[0], 'docker');
  const original = await readFile(docker, 'utf8');
  await writeFile(
    docker,
    original.replace(
      'if [ -n "$remove" ]; then',
      `if [ "$name" = navoss-valhalla-stage ]; then
      for argument do
        case "$argument" in *:/custom_files) graph=\${argument%:/custom_files} ;; esac
      done
      echo tiles >"$graph/valhalla_tiles.tar"
    fi
    if [ -n "$remove" ]; then`,
    ),
  );
  for (const step of ['inputs', 'valhalla']) {
    const result = stageAs(fixture, [step, 'new-brunswick'], false);
    assert.equal(result.status, 0, `${step}: ${result.stderr}`);
  }
  const imported = stageAs(fixture, ['nominatim', 'new-brunswick'], true);
  assert.equal(imported.status, 0, imported.stderr);
  const nominatim = join(fixture.root, 'nominatim', `new-brunswick-${VERSION}`);
  const uid = (await stat(fixture.root)).uid;
  assert.equal((await stat(nominatim)).uid, uid);
  assert.equal((await stat(join(nominatim, '.navoss-import-complete'))).uid, uid);
  assert.equal((await stat(join(fixture.root, '.stage.holder'))).uid, uid);
  assert.equal((await stat(join(nominatim, 'postgres'))).uid, 0);
  assert.equal((await stat(join(nominatim, 'staging-password.env'))).uid, 0);
  assert.equal((await stat(join(nominatim, 'staging-password.env'))).mode & 0o777, 0o600);
  assert.equal(
    (await stat(join(fixture.state, 'files', 'navoss-nominatim-stage', 'init.sh'))).mode & 0o777,
    0o666,
  );
  const status = stageAs(fixture, ['status', 'new-brunswick'], false);
  assert.equal(status.status, 0, status.stderr);
  assert.match(status.stdout, /\.navoss-import-complete/u);
  for (const step of ['inputs', 'valhalla']) {
    const result = stageAs(fixture, [step, 'new-brunswick'], false);
    assert.equal(result.status, 0, `${step}: ${result.stderr}`);
  }
  const stopped = stageAs(fixture, ['stop', 'new-brunswick'], true);
  assert.equal(stopped.status, 0, stopped.stderr);
  assert.equal(await exists(join(fixture.state, 'created', 'navoss-nominatim-stage')), false);
  // A stage completed by the old root-run script is repaired by the new serve step.
  const ownerCommand = process.getuid() === 0 ? 'chown' : 'sudo';
  const ownerArgs =
    process.getuid() === 0
      ? ['0:0', nominatim, join(nominatim, '.navoss-import-complete')]
      : ['-n', 'chown', '0:0', nominatim, join(nominatim, '.navoss-import-complete')];
  assert.equal(spawnSync(ownerCommand, ownerArgs).status, 0);
  const served = stageAs(fixture, ['serve', 'new-brunswick'], true);
  assert.equal(served.status, 0, served.stderr);
  assert.equal((await stat(nominatim)).uid, uid);
  assert.equal((await stat(join(nominatim, '.navoss-import-complete'))).uid, uid);
  const repairedStatus = stageAs(fixture, ['status', 'new-brunswick'], false);
  assert.equal(repairedStatus.status, 0, repairedStatus.stderr);
  assert.match(repairedStatus.stdout, /\.navoss-import-complete/u);
  const stoppedAgain = stageAs(fixture, ['stop', 'new-brunswick'], true);
  assert.equal(stoppedAgain.status, 0, stoppedAgain.stderr);
});

test('root-created stages can be resumed by the artifact owner', options, async (context) => {
  const fixture = await mixedFixture(context);
  await fakeBuildHelpers(fixture);
  const input = stageAs(fixture, ['inputs', 'new-brunswick'], true);
  assert.equal(input.status, 0, input.stderr);
  const uid = (await stat(fixture.root)).uid;
  assert.equal((await stat(join(fixture.root, '.stage.lock'))).uid, uid);
  assert.equal((await stat(join(fixture.root, 'imports', 'new-brunswick.stage-version'))).uid, uid);
  const docker = join(fixture.env.PATH.split(':')[0], 'docker');
  const original = await readFile(docker, 'utf8');
  await writeFile(
    docker,
    original.replace(
      'if [ -n "$remove" ]; then',
      `if [ "$name" = navoss-valhalla-stage ]; then
      for argument do
        case "$argument" in *:/custom_files) graph=\${argument%:/custom_files} ;; esac
      done
      echo tiles >"$graph/valhalla_tiles.tar"
    fi
    if [ -n "$remove" ]; then`,
    ),
  );
  const graph = stageAs(fixture, ['valhalla', 'new-brunswick'], true);
  assert.equal(graph.status, 0, graph.stderr);
  const directory = join(fixture.root, `valhalla-new-brunswick-${VERSION}`);
  assert.equal((await stat(directory)).uid, uid);
  assert.equal((await stat(join(directory, '.pass1-complete'))).uid, uid);
  assert.equal((await stat(join(directory, '.navoss-stage-complete'))).uid, uid);
  assert.equal((await stat(join(directory, 'valhalla_tiles.tar'))).uid, 0);
  const graphRetry = stageAs(fixture, ['valhalla', 'new-brunswick'], false);
  assert.doesNotMatch(graphRetry.stderr, /Permission denied|Operation not permitted/u);
  assert.equal(graphRetry.status, 0, graphRetry.stderr);
  const retry = stageAs(fixture, ['inputs', 'new-brunswick'], false);
  assert.doesNotMatch(retry.stderr, /Permission denied|Operation not permitted/u);
  assert.equal(retry.status, 0, retry.stderr);
});

test('an inaccessible live directory tells the operator to use sudo', options, async (context) => {
  const fixture = await mixedFixture(context);
  // Model the root-owned mode-750 ancestor on the production VM.
  const privateParent = join(fixture.root, 'private-live');
  await mkdir(join(privateParent, 'postgres'), { recursive: true });
  const chmodArgs = ['chmod', '0750', privateParent];
  const chownArgs = ['chown', '0:0', privateParent];
  for (const args of [chmodArgs, chownArgs]) {
    const result =
      process.getuid() === 0
        ? spawnSync(args[0], args.slice(1))
        : spawnSync('sudo', ['-n', ...args]);
    assert.equal(result.status, 0, String(result.stderr));
  }
  await setLive(fixture, { nominatim: join(privateParent, 'postgres') });
  const refused = stageAs(fixture, ['nominatim', 'new-brunswick'], false);
  assert.equal(refused.status, 1, refused.stderr);
  assert.match(refused.stderr, /Cannot inspect the live NOMINATIM_DATA_DIR.*sudo/u);
  assert.equal(startedAnything(await calls(fixture)), false);
});

function stageInBackground(fixture, args) {
  const child = spawn('sh', [join(fixture.compose, 'stage-coverage.sh'), ...args], {
    env: fixture.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const output = { stderr: '', stdout: '' };
  child.stdout.on('data', (chunk) => (output.stdout += String(chunk)));
  child.stderr.on('data', (chunk) => (output.stderr += String(chunk)));
  const exited = new Promise((resolve) =>
    child.on('exit', (code, signal) => resolve({ code, signal })),
  );
  return { child, exited, output };
}

async function until(predicate, what) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for ${what}`);
}

async function calls(fixture) {
  return (await exists(join(fixture.state, 'calls')))
    ? (await readFile(join(fixture.state, 'calls'), 'utf8')).split('\n').filter(Boolean)
    : [];
}

/** Starts a nominatim step and holds it between container creation and start (none running). */
async function holdHeavyStep(fixture, label) {
  await writeFile(join(fixture.state, 'hold'), '');
  const holder = stageInBackground(fixture, ['nominatim', label]);
  await until(() => exists(join(fixture.state, 'holding')), 'the step to reach its held point');
  return holder;
}

test(
  'a second heavy step is refused while one runs, even with no container up',
  options,
  async (context) => {
    const fixture = await createFixture(context, ['new-brunswick', 'nova-scotia']);
    const holder = await holdHeavyStep(fixture, 'new-brunswick');
    context.after(() => holder.child.kill('SIGKILL'));
    assert.equal((await readdir(join(fixture.state, 'running'))).length, 0);
    const before = (await calls(fixture)).length;

    for (const step of ['nominatim', 'valhalla', 'serve', 'inputs']) {
      const second = stage(fixture, [step, 'nova-scotia']);
      assert.equal(second.status, 1, `${step}: ${second.stdout}${second.stderr}`);
      assert.match(
        second.stderr,
        /Another staging step is running: nominatim new-brunswick/u,
        step,
      );
    }
    assert.deepEqual(
      (await calls(fixture)).slice(before),
      [],
      'the refused steps ran no docker command',
    );

    await rm(join(fixture.state, 'hold'));
    const finished = await holder.exited;
    assert.equal(finished.code, 0, holder.output.stderr);
  },
);

test(
  'stop ends the running step itself, then removes the staging containers',
  options,
  async (context) => {
    const fixture = await createFixture(context);
    const holder = await holdHeavyStep(fixture, 'new-brunswick');
    context.after(() => holder.child.kill('SIGKILL'));

    const stopped = stage(fixture, ['stop', 'new-brunswick']);

    assert.equal(stopped.status, 0, stopped.stderr);
    const finished = await Promise.race([
      holder.exited,
      new Promise((resolve) => setTimeout(() => resolve('still running'), 5_000)),
    ]);
    assert.notEqual(finished, 'still running', 'stop must end the step that holds the lock');
    assert.equal(await exists(join(fixture.state, 'created', 'navoss-nominatim-stage')), false);
    assert.match(stopped.stdout, /Stopped nominatim new-brunswick/u);
    // The lock is free again: the next step runs.
    await rm(join(fixture.state, 'hold'));
    const next = stage(fixture, ['nominatim', 'new-brunswick']);
    assert.equal(next.status, 0, next.stderr);
  },
);

test('a heavy step is refused while staged services are serving', options, async (context) => {
  const fixture = await createFixture(context);
  await mkdir(join(fixture.state, 'running'), { recursive: true });
  await writeFile(join(fixture.state, 'created', 'navoss-api-stage'), '').catch(async () => {
    await mkdir(join(fixture.state, 'created'), { recursive: true });
    await writeFile(join(fixture.state, 'created', 'navoss-api-stage'), '');
  });
  await writeFile(join(fixture.state, 'running', 'navoss-api-stage'), '');

  const refused = stage(fixture, ['nominatim', 'new-brunswick']);

  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /navoss-api-stage is running/u);
});

test(
  'the import runs both image scripts without tracing, with a staging-only password',
  options,
  async (context) => {
    const fixture = await createFixture(context);

    const imported = stage(fixture, ['nominatim', 'new-brunswick']);

    assert.equal(imported.status, 0, imported.stderr);
    const copied = join(fixture.state, 'files', 'navoss-nominatim-stage');
    for (const script of ['start.sh', 'init.sh']) {
      const content = await readFile(join(copied, script), 'utf8');
      assert.equal(content.split('\n')[0], '#!/bin/bash -e', script);
    }
    assert.match(
      await readFile(join(copied, 'init.sh'), 'utf8'),
      /max_locks_per_transaction = \$\{POSTGRES/u,
    );
    // Both import commands carry the container-sized cache; none is left to Nominatim's default.
    const imports = (await readFile(join(copied, 'init.sh'), 'utf8'))
      .split('\n')
      .filter((line) => line.includes('nominatim import'));
    assert.equal(imports.length, 2);
    for (const line of imports) assert.match(line, /--osm2pgsql-cache "\$\{OSM2PGSQL_CACHE:\?\}"/u);
    const stageDirectory = join(fixture.root, 'nominatim', `new-brunswick-${VERSION}`);
    const passwordFile = join(stageDirectory, 'staging-password.env');
    const password = await readFile(passwordFile, 'utf8');
    assert.match(password, /^NOMINATIM_PASSWORD=[0-9a-f]{48}\n$/u);
    assert.equal((await stat(passwordFile)).mode & 0o777, 0o600);
    const created = await readFile(
      join(fixture.state, 'created', 'navoss-nominatim-stage'),
      'utf8',
    );
    assert.match(created, new RegExp(`--env-file\n${passwordFile}\n`, 'u'));
    const everything = [...(await calls(fixture)), created, imported.stdout, imported.stderr].join(
      '\n',
    );
    assert.doesNotMatch(everything, /production-secret-value/u);
    assert.doesNotMatch(everything, new RegExp(password.split('=')[1].trim(), 'u'));
  },
);

test(
  'refuses to start an image whose scripts no longer match the tracing patch',
  options,
  async (context) => {
    const fixture = await createFixture(context);
    await writeFile(
      join(fixture.directory, 'upstream', 'start.sh'),
      '#!/bin/bash\nset -ex\nuseradd -m -p ${NOMINATIM_PASSWORD} nominatim\n',
    );

    const refused = stage(fixture, ['nominatim', 'new-brunswick']);

    assert.equal(refused.status, 1);
    assert.match(refused.stderr, /start\.sh no longer starts with/u);
    assert.equal(
      (await calls(fixture)).some((call) => call.startsWith('start ')),
      false,
    );
  },
);

async function interruptedImport(fixture, label = 'new-brunswick') {
  const stageDirectory = join(fixture.root, 'nominatim', `${label}-${VERSION}`);
  // What an interrupted import leaves: a cluster the image chowned to postgres, mode 0700, which
  // the operator's account cannot read or delete (the test runs unprivileged, as on the VM).
  const cluster = join(stageDirectory, 'postgres', 'base', '16384');
  await mkdir(cluster, { recursive: true });
  await writeFile(join(cluster, '1259'), 'heap');
  await writeFile(join(stageDirectory, '.navoss-import-started'), '');
  await chmod(join(stageDirectory, 'postgres', 'base'), 0o000);
  return stageDirectory;
}

test(
  'an interrupted import is discarded by a root container over exactly that stage',
  options,
  async (context) => {
    const fixture = await createFixture(context);
    const stageDirectory = await interruptedImport(fixture);

    const resumed = stage(fixture, ['nominatim', 'new-brunswick']);

    assert.equal(resumed.status, 0, resumed.stderr);
    assert.match(resumed.stdout, /Discarding the interrupted import/u);
    const cleanup = (await calls(fixture)).filter((call) => call.includes('--entrypoint rm'));
    assert.equal(cleanup.length, 1);
    assert.match(cleanup[0], /--network none/u);
    assert.match(cleanup[0], /--user 0/u);
    assert.match(
      cleanup[0],
      new RegExp(
        `src=${stageDirectory},dst=/stage,bind-recursive=disabled .* -rf /stage/postgres$`,
        'u',
      ),
    );
    assert.equal(cleanup[0].match(/ (-v|--mount) /gu)?.length, 1, 'one mount: the stage');
    assert.equal(await exists(join(stageDirectory, '.navoss-import-complete')), true);
  },
);

test(
  'never discards the live cluster or a path outside the staging pattern',
  options,
  async (context) => {
    const fixture = await createFixture(context);
    const stageDirectory = await interruptedImport(fixture);
    // The live directory is the staged one through a symlink.
    await rm(fixture.live, { recursive: true });
    await symlink(join(stageDirectory, 'postgres'), fixture.live);

    const refused = stage(fixture, ['nominatim', 'new-brunswick']);

    assert.equal(refused.status, 1);
    assert.match(refused.stderr, /live NOMINATIM_DATA_DIR/u);
    assert.equal(
      (await calls(fixture)).some((call) => call.includes('--entrypoint rm')),
      false,
    );
  },
);

test(
  'serve starts Nominatim over the chosen stage, not the last import',
  options,
  async (context) => {
    const fixture = await createFixture(context, ['canada', 'nova-scotia']);
    for (const label of ['canada', 'nova-scotia']) {
      const imported = stage(fixture, ['nominatim', label]);
      assert.equal(imported.status, 0, imported.stderr);
    }
    const graph = join(fixture.root, `valhalla-canada-${VERSION}`);
    await mkdir(graph, { recursive: true });
    await writeFile(join(graph, '.navoss-stage-complete'), '');

    const served = stage(fixture, ['serve', 'canada']);

    assert.equal(served.status, 0, served.stderr);
    const created = (
      await readFile(join(fixture.state, 'created', 'navoss-nominatim-stage'), 'utf8')
    ).split('\n');
    const canada = join(fixture.root, 'nominatim', `canada-${VERSION}`);
    assert.ok(
      created.includes(`${canada}/postgres:/var/lib/postgresql/16/main`),
      created.join(' '),
    );
    assert.ok(
      created.includes(
        `${join(fixture.root, 'imports', `canada-${VERSION}.osm.pbf`)}:/regional-data/regional.osm.pbf:ro`,
      ),
    );
    assert.ok(created.includes(`${canada}/staging-password.env`));
    assert.ok(created.includes('navoss-stage'), 'joins the staging network');
    assert.equal(await exists(join(fixture.state, 'running', 'navoss-nominatim-stage')), true);
    const copied = join(fixture.state, 'files', 'navoss-nominatim-stage', 'start.sh');
    assert.equal((await readFile(copied, 'utf8')).split('\n')[0], '#!/bin/bash -e');
  },
);

const startedAnything = (list) => list.some((call) => /^(create|run|start) /u.test(call));

test('every step runs from the one exported release', options, async (context) => {
  const fixture = await createFixture(context);
  for (const step of ['inputs', 'nominatim', 'serve']) {
    const unpinned = stage(fixture, [step, 'new-brunswick'], { GEOFABRIK_VERSION: '' });
    assert.equal(unpinned.status, 64, step);
    assert.match(unpinned.stderr, /export GEOFABRIK_VERSION=/u, step);
  }
  const newer = stage(fixture, ['nominatim', 'new-brunswick'], { GEOFABRIK_VERSION: '261201' });
  assert.equal(newer.status, 1);
  assert.match(
    newer.stderr,
    /GEOFABRIK_VERSION=261201, but 'new-brunswick' was prepared from 261114/u,
  );
  const restaged = stage(fixture, ['inputs', 'new-brunswick'], { GEOFABRIK_VERSION: '261201' });
  assert.equal(restaged.status, 1);
  assert.match(restaged.stderr, /staged from 261114; remove .* to start 261201/u);
  assert.equal(startedAnything(await calls(fixture)), false);
});

test('a step refuses to start without its disk space', options, async (context) => {
  const fixture = await createFixture(context);

  const refused = stage(fixture, ['nominatim', 'new-brunswick'], { STAGE_MIN_FREE_GB: '999999' });

  assert.equal(refused.status, 1);
  assert.match(
    refused.stderr,
    /nominatim needs 999999 GB free on .*; \d+ GB is\. Nothing was started\./u,
  );
  assert.equal(startedAnything(await calls(fixture)), false);
});

test('every staging container has a memory cap', options, async (context) => {
  const fixture = await createFixture(context);
  const stageDirectory = await interruptedImport(fixture);
  assert.equal(stage(fixture, ['nominatim', 'new-brunswick']).status, 0);
  await mkdir(join(fixture.root, `valhalla-new-brunswick-${VERSION}`), { recursive: true });
  await writeFile(
    join(fixture.root, `valhalla-new-brunswick-${VERSION}`, '.navoss-stage-complete'),
    '',
  );
  assert.equal(stage(fixture, ['serve', 'new-brunswick']).status, 0);

  const started = (await calls(fixture)).filter((call) => /^(create|run) /u.test(call));
  assert.equal(started.length, 5, started.join('\n')); // cleanup, import, then the three served
  for (const call of started) {
    const memory = /--memory (\S+) --memory-swap (\S+)/u.exec(call);
    assert.ok(memory, call);
    assert.equal(memory[1], memory[2], call);
  }
  assert.ok(stageDirectory);
});

// After a cutover the staged directories are the live ones, named however `.env` names them.
async function setLive(
  fixture,
  { nominatim = fixture.live, valhalla = fixture.liveValhalla } = {},
) {
  await writeFile(
    join(fixture.compose, '.env'),
    `NOMINATIM_PASSWORD=production-secret-value\nNOMINATIM_DATA_DIR=${nominatim}\nVALHALLA_DATA_DIR=${valhalla}\n`,
  );
}

async function completedStages(fixture, label = 'new-brunswick') {
  const nominatim = join(fixture.root, 'nominatim', `${label}-${VERSION}`);
  const valhalla = join(fixture.root, `valhalla-${label}-${VERSION}`);
  await mkdir(join(nominatim, 'postgres'), { recursive: true });
  await writeFile(join(nominatim, '.navoss-import-complete'), '');
  await mkdir(valhalla, { recursive: true });
  await writeFile(join(valhalla, '.navoss-stage-complete'), '');
  return { nominatim, valhalla };
}

test(
  'serve refuses a stage that is the live data, however .env names it',
  options,
  async (context) => {
    for (const which of ['nominatim', 'valhalla']) {
      const fixture = await createFixture(context);
      await completedStages(fixture);
      await setLive(
        fixture,
        which === 'nominatim'
          ? { nominatim: `${fixture.root}/./nominatim/new-brunswick-${VERSION}/postgres` }
          : { valhalla: `${fixture.root}/.//valhalla-new-brunswick-${VERSION}/` },
      );

      const refused = stage(fixture, ['serve', 'new-brunswick']);

      assert.equal(refused.status, 1, which);
      assert.match(refused.stderr, /is the live (NOMINATIM|VALHALLA)_DATA_DIR/u, which);
      assert.equal(startedAnything(await calls(fixture)), false, which);
    }
  },
);

test('valhalla changes nothing in a stage that is the live graph', options, async (context) => {
  const fixture = await createFixture(context);
  const { valhalla } = await completedStages(fixture);
  await writeFile(
    join(valhalla, `new-brunswick-${VERSION}.osm.pbf`),
    'routing input it was built from',
  );
  await writeFile(join(valhalla, '.pass1-complete'), '');
  await writeFile(
    join(fixture.root, 'imports', `new-brunswick-${VERSION}.routing.osm.pbf`),
    'regenerated',
  );
  await setLive(fixture, { valhalla: `${fixture.root}/./valhalla-new-brunswick-${VERSION}` });

  const refused = stage(fixture, ['valhalla', 'new-brunswick']);

  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /is the live VALHALLA_DATA_DIR/u);
  for (const file of [
    `new-brunswick-${VERSION}.osm.pbf`,
    '.pass1-complete',
    '.navoss-stage-complete',
  ]) {
    assert.equal(await exists(join(valhalla, file)), true, file);
  }
});

test('refuses cleanup when the live cluster path cannot be inspected', options, async (context) => {
  const fixture = await mixedFixture(context);
  const stageDirectory = await interruptedImport(fixture);
  // Docker resolves this to the staged cluster; the operator cannot traverse the 0700 directory.
  await chmod(join(stageDirectory, 'postgres'), 0o000);
  for (const [live, refusal] of [
    // Docker resolves `..` to the staged cluster itself.
    [
      join(stageDirectory, 'postgres', 'base', '..'),
      /(Cannot inspect the live|is the live) NOMINATIM_DATA_DIR/u,
    ],
    // Not inspectable at all: refused, never assumed to be another directory.
    [join(stageDirectory, 'postgres', 'base'), /Cannot inspect the live NOMINATIM_DATA_DIR/u],
  ]) {
    await setLive(fixture, { nominatim: live });

    const refused = stageAs(fixture, ['nominatim', 'new-brunswick'], false);

    assert.equal(refused.status, 1, live);
    assert.match(refused.stderr, refusal, live);
  }
  assert.equal(
    (await calls(fixture)).some((call) => call.includes('--entrypoint rm')),
    false,
  );
});

test(
  'no staging container starts while another step left one running',
  options,
  async (context) => {
    for (const leftover of ['nominatim', '']) {
      const fixture = await createFixture(context);
      await completedStages(fixture);
      // A crashed import's container: the lock is free, the 10g container is not.
      for (const kind of ['created', 'running', 'labels']) {
        await mkdir(join(fixture.state, kind), { recursive: true });
      }
      await writeFile(join(fixture.state, 'created', 'navoss-nominatim-stage'), '');
      await writeFile(join(fixture.state, 'running', 'navoss-nominatim-stage'), '');
      await writeFile(join(fixture.state, 'labels', 'navoss-nominatim-stage'), leftover);

      const refused = stage(fixture, ['serve', 'new-brunswick']);

      assert.equal(refused.status, 1, leftover);
      assert.match(refused.stderr, /navoss-nominatim-stage is running/u);
      assert.equal(startedAnything(await calls(fixture)), false, leftover);
    }
  },
);

test(
  'every staging container is labelled with the step that started it',
  options,
  async (context) => {
    const fixture = await createFixture(context);
    await completedStages(fixture);
    assert.equal(stage(fixture, ['serve', 'new-brunswick']).status, 0);
    for (const name of ['navoss-valhalla-stage', 'navoss-nominatim-stage', 'navoss-api-stage']) {
      assert.equal(await readFile(join(fixture.state, 'labels', name), 'utf8'), 'serve\n', name);
    }
  },
);

test('stop never signals a process it cannot verify as the holder', options, async (context) => {
  const fixture = await createFixture(context);
  // The lock is held, but the holder record is stale: its pid now names an unrelated process.
  const unrelated = spawn('sleep', ['30']);
  const locker = spawn('flock', [join(fixture.root, '.stage.lock'), 'sleep', '30']);
  context.after(() => {
    unrelated.kill('SIGKILL');
    locker.kill('SIGKILL');
  });
  await new Promise((resolve) => setTimeout(resolve, 300));
  await writeFile(
    join(fixture.root, '.stage.holder'),
    `${String(unrelated.pid)} 1 ${await readFile('/proc/sys/kernel/random/boot_id', 'utf8').then((id) => id.trim())} nominatim new-brunswick\n`,
  );

  const stopped = stage(fixture, ['stop', 'new-brunswick'], { STAGE_HOLDER_WAIT: '1' });

  assert.equal(stopped.status, 1);
  assert.match(stopped.stderr, /cannot be verified/u);
  assert.equal(unrelated.exitCode, null, 'the unrelated process was not signalled');
  assert.equal(unrelated.signalCode, null);
});

test('every step refuses without the deployed .env beside it', options, async (context) => {
  const fixture = await createFixture(context);
  await rm(join(fixture.compose, '.env'));
  for (const step of ['status', 'nominatim', 'stop']) {
    const refused = stage(fixture, [step, 'new-brunswick']);
    assert.equal(refused.status, 1, step);
    assert.match(refused.stderr, /\.env is missing or unreadable/u, step);
  }
  assert.deepEqual(await calls(fixture), []);
});

test(
  'an interrupted first pass is cleared even where the container wrote as root',
  options,
  async (context) => {
    const fixture = await createFixture(context);
    const valhalla = join(fixture.root, `valhalla-new-brunswick-${VERSION}`);
    // What pass 1 leaves on the VM: a tile tree and files the operator cannot delete.
    await mkdir(join(valhalla, 'valhalla_tiles', '2', '000'), { recursive: true });
    await writeFile(join(valhalla, 'valhalla_tiles', '2', '000', '123.gph'), 'tile');
    await writeFile(join(valhalla, 'valhalla.json'), '{}');
    await chmod(join(valhalla, 'valhalla_tiles', '2'), 0o555);
    await chmod(join(valhalla, 'valhalla_tiles'), 0o555);
    await writeFile(
      join(fixture.root, 'imports', `new-brunswick-${VERSION}.routing.osm.pbf`),
      'input',
    );
    await writeFile(join(fixture.liveValhalla, 'timezones.sqlite'), 'zones');

    // The speed profile download then fails here (no network in the test); the cleanup came first.
    stage(fixture, ['valhalla', 'new-brunswick']);

    const cleanup = (await calls(fixture)).filter((call) => call.includes('--entrypoint rm'));
    assert.equal(cleanup.length, 1);
    assert.match(
      cleanup[0],
      new RegExp(
        `src=${valhalla},dst=/stage,bind-recursive=disabled .* -rf /stage/valhalla_tiles `,
        'u',
      ),
    );
    assert.match(cleanup[0], /--user 0 .*--network none|--network none .*--user 0/u);
    assert.equal(await exists(join(valhalla, 'valhalla_tiles')), false);
    assert.equal(await exists(join(valhalla, 'valhalla.json')), false);
    assert.equal(await exists(join(valhalla, `new-brunswick-${VERSION}.osm.pbf`)), true);
  },
);

test(
  'cleanup refuses a Docker that would mount the stage with its submounts',
  options,
  async (context) => {
    const fixture = await createFixture(context);
    await interruptedImport(fixture);

    const refused = stage(fixture, ['nominatim', 'new-brunswick'], {
      FAKE_DOCKER_VERSION: '24.0.7',
    });

    assert.equal(refused.status, 1);
    assert.match(refused.stderr, /needs 25 or later/u);
    assert.equal(
      (await calls(fixture)).some((call) => call.includes('--entrypoint rm')),
      false,
    );
  },
);

test(
  'a relative live path in .env is relative to the .env, not the caller',
  options,
  async (context) => {
    const fixture = await createFixture(context);
    await completedStages(fixture);
    await setLive(fixture, {
      nominatim: `../artifacts/nominatim/new-brunswick-${VERSION}/postgres`,
    });

    const refused = stage(fixture, ['serve', 'new-brunswick']);

    assert.equal(refused.status, 1);
    assert.match(refused.stderr, /is the live NOMINATIM_DATA_DIR/u);
  },
);

test('stop treats a holder record from another boot as no holder', options, async (context) => {
  const fixture = await createFixture(context);
  const locker = spawn('flock', [join(fixture.root, '.stage.lock'), 'sleep', '30']);
  context.after(() => locker.kill('SIGKILL'));
  await new Promise((resolve) => setTimeout(resolve, 300));
  // The right pid and start time, recorded under another boot.
  const start = (await readFile(`/proc/${String(locker.pid)}/stat`, 'utf8'))
    .replace(/^.*\) /su, '')
    .split(' ')[19];
  await writeFile(
    join(fixture.root, '.stage.holder'),
    `${String(locker.pid)} ${String(start)} 00000000-0000-0000-0000-000000000000 nominatim new-brunswick\n`,
  );

  const stopped = stage(fixture, ['stop', 'new-brunswick'], { STAGE_HOLDER_WAIT: '1' });

  assert.equal(stopped.status, 1);
  assert.match(stopped.stderr, /cannot be verified/u);
  assert.equal(locker.exitCode, null);
  assert.equal(locker.signalCode, null);
});
