import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const repairScript = join(repositoryRoot, 'infra/compose/repair-valhalla-admins.sh');

async function createFixture(preflight = '2|2|0|0') {
  const fixture = await mkdtemp(join(tmpdir(), 'navoss-valhalla-admin-repair-'));
  const dataDirectory = join(fixture, 'data');
  const runtime = join(fixture, 'container-runtime');
  await mkdir(dataDirectory);
  await writeFile(join(dataDirectory, 'admins.sqlite'), 'original-admin-database');
  await writeFile(
    runtime,
    `#!/bin/sh
sql=
for argument do
  sql=$argument
done
case "$sql" in
  *"BEGIN IMMEDIATE"*)
    : > "$FAKE_REPAIR_STATE"
    ;;
  *"ST_Covers(country.geom"*)
    printf '1|2|2|0|0\\n'
    ;;
  *)
    if [ -e "$FAKE_REPAIR_STATE" ]; then
      printf '2|2|1|0\\n'
    else
      printf '%s\\n' "$FAKE_PREFLIGHT"
    fi
    ;;
esac
`,
  );
  await chmod(runtime, 0o755);
  return { dataDirectory, fixture, preflight, runtime };
}

function runRepair({ dataDirectory, fixture, preflight, runtime }) {
  return spawnSync('sh', [repairScript, dataDirectory], {
    encoding: 'utf8',
    env: {
      ...process.env,
      CONTAINER_RUNTIME: runtime,
      FAKE_PREFLIGHT: preflight,
      FAKE_REPAIR_STATE: join(fixture, 'repaired'),
    },
  });
}

test('repairs once, preserves the rollback database, and permits repeat validation', async (context) => {
  const fixture = await createFixture();
  context.after(() => rm(fixture.fixture, { force: true, recursive: true }));

  const first = runRepair(fixture);
  const second = runRepair(fixture);

  assert.equal(first.status, 0, first.stderr);
  assert.equal(second.status, 0, second.stderr);
  assert.match(first.stdout, /2 Alberta and 2 British Columbia rows linked to Canada/);
  assert.equal(
    await readFile(join(fixture.dataDirectory, 'admins.pre-country-parent.sqlite'), 'utf8'),
    'original-admin-database',
  );
});

for (const [name, preflight, expectedError] of [
  ['missing province', '2|0|0|0', /Expected both Alberta and British Columbia/],
  ['duplicate Canada parents', '2|2|2|0', /Expected at most one Canada parent/],
  ['invalid province geometry', '2|2|0|1', /invalid Alberta\/British Columbia/],
]) {
  test(`fails closed for ${name}`, async (context) => {
    const fixture = await createFixture(preflight);
    context.after(() => rm(fixture.fixture, { force: true, recursive: true }));

    const result = runRepair(fixture);

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, expectedError);
  });
}
