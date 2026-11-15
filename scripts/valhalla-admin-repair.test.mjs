import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const repairScript = join(repositoryRoot, 'infra/compose/repair-valhalla-admins.sh');

async function createFixture({
  preflight = '4|0|0',
  provinceRows = 'AB=2 BC=2',
  postflight = '1|4|0|0',
} = {}) {
  const fixture = await mkdtemp(join(tmpdir(), 'navoss-valhalla-admin-repair-'));
  const dataDirectory = join(fixture, 'data');
  const runtime = join(fixture, 'container-runtime');
  await mkdir(dataDirectory);
  await writeFile(join(dataDirectory, 'admins.sqlite'), 'original-admin-database');
  // Answers each query of the script the way spatialite would for the configured database.
  await writeFile(
    runtime,
    `#!/bin/sh
sql=
for argument do
  sql=$argument
done
case "$sql" in
  *"BEGIN IMMEDIATE"*)
    printf '%s\\n' "$sql" > "$FAKE_REPAIR_STATE"
    ;;
  *"ST_Covers(country.geom"*)
    printf '%s\\n' "$FAKE_POSTFLIGHT"
    ;;
  "SELECT COUNT(*) FROM admins WHERE admin_level = 4 AND iso_code = '"*)
    code=$(printf '%s' "$sql" | sed -n "s/.*iso_code = '\\([A-Z][A-Z]\\)'.*/\\1/p")
    for entry in $FAKE_PROVINCE_ROWS; do
      if [ "\${entry%%=*}" = "$code" ]; then printf '%s\\n' "\${entry#*=}"; exit 0; fi
    done
    printf '0\\n'
    ;;
  *)
    printf '%s\\n' "$FAKE_PREFLIGHT"
    ;;
esac
`,
  );
  await chmod(runtime, 0o755);
  return { dataDirectory, fixture, postflight, preflight, provinceRows, runtime };
}

function runRepair(
  { dataDirectory, fixture, postflight, preflight, provinceRows, runtime },
  provinces = undefined,
) {
  return spawnSync('sh', [repairScript, dataDirectory], {
    encoding: 'utf8',
    env: {
      ...process.env,
      CONTAINER_RUNTIME: runtime,
      FAKE_POSTFLIGHT: postflight,
      FAKE_PREFLIGHT: preflight,
      FAKE_PROVINCE_ROWS: provinceRows,
      FAKE_REPAIR_STATE: join(fixture, 'repaired'),
      ...(provinces === undefined ? {} : { VALHALLA_ADMIN_PROVINCES: provinces }),
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
  assert.match(first.stdout, /4 province rows \(AB BC\) linked to Canada/);
  assert.match(await readFile(join(fixture.fixture, 'repaired'), 'utf8'), /IN \('AB', 'BC'\)/);
  assert.equal(
    await readFile(join(fixture.dataDirectory, 'admins.pre-country-parent.sqlite'), 'utf8'),
    'original-admin-database',
  );
});

test('links Ontario to Canada for the merged graph', async (context) => {
  const fixture = await createFixture({
    postflight: '1|5|0|0',
    preflight: '5|0|0',
    provinceRows: 'AB=2 BC=2 ON=1',
  });
  context.after(() => rm(fixture.fixture, { force: true, recursive: true }));

  const result = runRepair(fixture, 'AB BC ON');

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /5 province rows \(AB BC ON\) linked to Canada/);
  assert.match(
    await readFile(join(fixture.fixture, 'repaired'), 'utf8'),
    /IN \('AB', 'BC', 'ON'\)/,
  );
});

for (const [name, options, provinces, expectedError] of [
  ['missing province', { provinceRows: 'AB=2' }, undefined, /Expected a BC admin polygon/],
  ['missing Ontario', { provinceRows: 'AB=2 BC=2' }, 'AB BC ON', /Expected a ON admin polygon/],
  ['duplicate Canada parents', { preflight: '4|2|0' }, undefined, /at most one Canada parent/],
  ['invalid province geometry', { preflight: '4|0|1' }, undefined, /1 invalid admin polygons/],
  ['an unlinked province', { postflight: '1|3|0|0' }, undefined, /failed validation/],
  ['an unsupported province', {}, 'AB XX', /Unsupported province/],
  ['a repeated province', {}, 'AB AB', /listed twice/],
]) {
  test(`fails closed for ${name}`, async (context) => {
    const fixture = await createFixture(options);
    context.after(() => rm(fixture.fixture, { force: true, recursive: true }));

    const result = runRepair(fixture, provinces);

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, expectedError);
  });
}
