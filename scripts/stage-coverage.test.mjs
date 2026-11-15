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
`,
  'start.sh': `#!/bin/bash -ex
useradd -m -p \${NOMINATIM_PASSWORD} nominatim
`,
};

const fakeDocker = `#!/bin/sh
# State: $FAKE_STATE/created/<name> holds the create/run arguments, one per line;
# $FAKE_STATE/running/<name> marks a running container; files/<name>/<path> what was copied in.
state=$FAKE_STATE
mkdir -p "$state/created" "$state/running" "$state/files"
printf '%s\\n' "$*" >>"$state/calls"
command=$1
shift
case "$command" in
  ps) ls "$state/running" ;;
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
            previous=$argument
          done
          for target do :; done
          host=\${mount%%:*}
          inside=\${mount#*:}
          path=$host\${target#"$inside"}
          chmod -R u+rwx "$path" 2>/dev/null
          rm -rf "$path"
          ;;
      esac
      exit 0
    fi
    for argument do printf '%s\\n' "$argument"; done >"$state/created/$name"
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
        ;;
    esac
    ;;
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
  context.after(() => rm(directory, { force: true, recursive: true }));
  const compose = join(directory, 'compose');
  const bin = join(directory, 'bin');
  const root = join(directory, 'artifacts');
  const upstream = join(directory, 'upstream');
  const state = join(directory, 'docker');
  const live = join(root, 'nominatim', 'live', 'postgres');
  for (const path of [compose, bin, join(root, 'imports'), upstream, state, live]) {
    await mkdir(path, { recursive: true });
  }
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
  return { compose, directory, env, live, root, state };
}

function stage(fixture, args, env = {}) {
  return spawnSync('sh', [join(fixture.compose, 'stage-coverage.sh'), ...args], {
    encoding: 'utf8',
    env: { ...fixture.env, ...env },
    timeout: 30_000,
  });
}

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
