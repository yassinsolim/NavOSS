import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmod, copyFile, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const hasJq = spawnSync('jq', ['--version']).status === 0;

async function fixture(t, mode) {
  const dir = await mkdtemp(join(tmpdir(), 'navoss-check-stack-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const bin = join(dir, 'bin');
  await mkdir(bin);
  await copyFile(join(root, 'infra/compose/check-stack.sh'), join(dir, 'check-stack.sh'));
  await writeFile(join(dir, 'check-coverage.sh'), '#!/bin/sh\nexit 0\n');
  const commands = {
    curl: `#!/bin/sh
args="$*"
case "$args" in
  *--write-out*) echo 200 ;;
  */v2/config) echo '{"features":{"productionSearch":true}}' ;;
  *Tim\\ Hortons*) echo '{"results":[{"id":"calgary-business:1"}]}' ;;
  *800\\ Macleod*) echo '{"results":[{"name":"800 Macleod Trail SE","center":{"latitude":51.04539715854496,"longitude":-114.05792721246195}}]}' ;;
  */v1/search) echo '{"degraded":false,"source":{"id":"calgary-hybrid-search","freshness":"fresh"},"results":[{}]}' ;;
  */v1/routes) echo '{"degraded":false,"source":{"id":"valhalla-self-hosted","mode":"production"},"routes":[{"distanceMeters":19000,"durationSeconds":1200}]}' ;;
  */v2/traffic/status) echo '{"mode":"off","probes":{"accepting":false,"tripEndTrimMeters":400},"publication":{"minimumContributors":3}}' ;;
  */v1/offline/manifest) echo '{"bundleVersion":"v1","regions":[{"artifacts":[]}]}' ;;
  *) echo '{}' ;;
esac
`,
    systemctl: `#!/bin/sh
case "$*" in
  *is-active*) exit 0 ;;
  *ActiveState*)
    if { [ "$FAKE_MODE" = running ] || [ "$FAKE_MODE" = withdrawn ]; } && [ ! -f "$FAKE_DIR/finished" ]; then echo activating; elif [ "$FAKE_MODE" = stuck ]; then echo activating; else echo inactive; fi ;;
  *Result*) if [ "$FAKE_MODE" = failed ]; then echo failed; else echo success; fi ;;
  *ExecMainExitTimestamp*) if [ "$FAKE_MODE" = never ]; then echo ''; else echo recent; fi ;;
esac
`,
    date: '#!/bin/sh\nif [ "$FAKE_MODE" = stale ] && [ "$1" = -d ]; then echo 0; else echo 1000; fi\n',
    sleep:
      '#!/bin/sh\ntouch "$FAKE_DIR/finished"\nif [ "$FAKE_MODE" = withdrawn ]; then rm "$FAKE_DIR/manifest.json"; fi\n',
  };
  for (const [name, content] of Object.entries(commands)) {
    const file = join(bin, name);
    await writeFile(file, content);
    await chmod(file, 0o755);
  }
  await chmod(join(dir, 'check-coverage.sh'), 0o755);
  await writeFile(
    join(dir, 'manifest.json'),
    '{"bundleVersion":"v1","regions":[{"artifacts":[]}]}',
  );
  return spawnSync('sh', [join(dir, 'check-stack.sh')], {
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      FAKE_MODE: mode,
      FAKE_DIR: dir,
      NAVOSS_OFFLINE_MANIFEST_DIR: dir,
    },
  });
}

test(
  'a guard running at check time is awaited and its completed result checked',
  { skip: !hasJq },
  async (t) => {
    const result = await fixture(t, 'running');
    assert.equal(result.status, 0, result.stderr);
  },
);
test('failed or never-completed guards still fail', { skip: !hasJq }, async (t) => {
  for (const mode of ['failed', 'never', 'stale']) {
    const result = await fixture(t, mode);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Offline guard last run/);
  }
});

test('a stuck guard or withdrawal during its run fails closed', { skip: !hasJq }, async (t) => {
  for (const mode of ['stuck', 'withdrawn']) {
    const result = await fixture(t, mode);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Offline (guard|manifest)/);
  }
});
