import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

// Runs the real infra/compose/check-coverage.sh with the committed Canada matrix against a stand-in
// `curl` that answers like an API declaring FAKE_DECLARED: a strict v1 config, a ready /ready, and
// for /v2/routes the corridor its anchors belong to at the middle of its range (logged by id).
const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const checkScript = join(repositoryRoot, 'infra/compose/check-coverage.sh');
const canadaMatrix = join(repositoryRoot, 'apps/api/scripts/route-quality-canada.json');
const hasJq = spawnSync('jq', ['--version']).status === 0;

const fakeCurl = `#!/bin/sh
url=
for argument do url=$argument; done
case "$url" in
  */v1/config)
    printf '%s' '{"apiVersion":"v1","coverage":{"id":"calgary-ab","displayName":"Calgary, Alberta"},"endpoints":{"routes":"/v1/routes"}}'
    ;;
  */v2/config)
    printf '%s' "$FAKE_DECLARED" | tr ',' '\\n' |
      jq -R '{id: ., boundary: {type: "MultiPolygon"}}' | jq -cs '{coverage: {serviceAreas: .}, endpoints: {routes: "/v2/routes"}}'
    ;;
  */ready)
    printf '%s' '{"status":"ready","checks":{"coverage":{"status":"ready"}}}'
    ;;
  */v2/routes)
    request=$(cat)
    jq -c --argjson request "$request" '
      . as $m | [.corridors[] | select($m.anchors[.originAnchorId].coordinate == $request.origin
        and $m.anchors[.destinationAnchorId].coordinate == $request.destination)] | first
      | {degraded: false, source: {id: "valhalla-self-hosted"},
         routes: [{distanceMeters: ((.distanceRangeKm[0] + .distanceRangeKm[1]) * 500),
           steps: [range(.minimumLaneManeuvers // 0) | {lanes: [{}]}]}], corridor: .id}' "$FAKE_MATRIX" |
      tee -a "$FAKE_ROUTES" >/dev/null
    jq -c 'del(.corridor)' "$FAKE_ROUTES" | tail -n 1
    ;;
  *) exit 22 ;;
esac
`;

async function fixture(context) {
  const directory = await mkdtemp(join(tmpdir(), 'navoss-check-coverage-'));
  context.after(() => rm(directory, { force: true, recursive: true }));
  await writeFile(join(directory, 'curl'), fakeCurl);
  await chmod(join(directory, 'curl'), 0o755);
  return directory;
}

async function check(directory, declared, matrix = canadaMatrix) {
  const routes = join(directory, 'routes.jsonl');
  await writeFile(routes, '');
  const result = spawnSync('sh', [checkScript], {
    encoding: 'utf8',
    env: {
      ...process.env,
      FAKE_DECLARED: declared,
      FAKE_MATRIX: matrix,
      FAKE_ROUTES: routes,
      NAVOSS_BASE_URL: 'http://api.invalid',
      NAVOSS_SERVICE_AREAS: declared,
      PATH: `${directory}:${String(process.env.PATH)}`,
      ROUTE_QUALITY_CANADA: matrix,
    },
  });
  const requested = (await readFile(routes, 'utf8'))
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line).corridor);
  return { requested, result };
}

const options = { skip: !hasJq && 'jq is not installed' };

test('routes inside every province declared alone, except Nunavut', options, async (context) => {
  const directory = await fixture(context);
  for (const [province, corridor] of [
    ['nova-scotia', 'halifax-dartmouth'],
    ['prince-edward-island', 'charlottetown-summerside'],
    ['newfoundland-and-labrador', 'st-johns-mount-pearl'],
    ['manitoba', 'winnipeg-brandon'],
    ['yukon', 'whitehorse-carcross'],
    ['northwest-territories', 'yellowknife-behchoko'],
    ['new-brunswick', 'moncton-saint-john'],
    ['saskatchewan', 'regina-saskatoon'],
  ]) {
    const { requested, result } = await check(directory, province);
    assert.equal(result.status, 0, `${province}: ${result.stderr}`);
    assert.deepEqual(requested, [corridor], province);
  }
  const nunavut = await check(directory, 'nunavut');
  assert.equal(nunavut.result.status, 0, nunavut.result.stderr);
  assert.deepEqual(nunavut.requested, []);
});

test(
  'fails when a declared province other than Nunavut has no route case',
  options,
  async (context) => {
    const directory = await fixture(context);
    const matrix = JSON.parse(await readFile(canadaMatrix, 'utf8'));
    matrix.corridors = matrix.corridors.filter(({ id }) => id !== 'halifax-dartmouth');
    const trimmed = join(directory, 'matrix.json');
    await writeFile(trimmed, JSON.stringify(matrix));

    const { requested, result } = await check(directory, 'nova-scotia', trimmed);

    assert.equal(result.status, 1);
    assert.match(result.stderr, /nova-scotia: no route case in matrix\.json applies/u);
    assert.deepEqual(requested, []);
  },
);
