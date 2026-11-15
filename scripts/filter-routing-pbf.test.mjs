import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

// Runs the real infra/compose/filter-routing-pbf.sh with the real osmium on an OPL extract shaped
// like the Dempster case: an ice-road way that is a member of a route relation, beside an ordinary
// road in the same relation. CI installs osmium-tool and sets NAVOSS_REQUIRE_OSMIUM=1.
const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const filterScript = join(repositoryRoot, 'infra/compose/filter-routing-pbf.sh');
const hasOsmium = spawnSync('osmium', ['--version']).status === 0;
if (!hasOsmium && process.env.NAVOSS_REQUIRE_OSMIUM === '1') {
  throw new Error('osmium is required (NAVOSS_REQUIRE_OSMIUM=1).');
}

const extract = [
  'n1 v1 x-133.70 y68.35',
  'n2 v1 x-133.60 y68.40',
  'n3 v1 x-133.72 y68.36',
  'n4 v1 x-133.71 y68.37',
  'n5 v1 x-133.80 y68.30',
  'n6 v1 x-133.81 y68.31',
  'w10 v1 Thighway=unclassified,ice_road=yes Nn1,n2',
  'w11 v1 Thighway=primary,ref=8 Nn3,n4',
  'w12 v1 Thighway=track,seasonal=winter Nn5,n6',
  'r20 v1 Ttype=route,route=road,ref=8 Mw10@,w11@',
  '',
].join('\n');

function osmium(...args) {
  const result = spawnSync('osmium', args, { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}

test(
  'removes a seasonal way even when a relation references it, and counts what it removed',
  { skip: !hasOsmium && 'osmium is not installed' },
  async (context) => {
    const directory = await mkdtemp(join(tmpdir(), 'navoss-filter-routing-'));
    context.after(() => rm(directory, { force: true, recursive: true }));
    const opl = join(directory, 'fixture.opl');
    const input = join(directory, 'north-261114.osm.pbf');
    await writeFile(opl, extract);
    osmium('cat', '--overwrite', '--output', input, opl);

    const result = spawnSync('sh', [filterScript, input], { encoding: 'utf8' });

    assert.equal(result.status, 0, result.stderr);
    const routing = osmium(
      'cat',
      '--output-format',
      'opl',
      join(directory, 'north-261114.routing.osm.pbf'),
    );
    const ways = routing.match(/^w\d+/gmu) ?? [];
    assert.deepEqual(ways, ['w11'], 'only the ordinary road is routed');
    assert.match(routing, /^r20 /mu, 'the route relation stays for its ordinary member');
    const report = await readFile(join(directory, 'north-261114.routing.removed.txt'), 'utf8');
    assert.match(report, /^Removed 2 seasonal or ice-road ways /u);
    // A second run reuses the verified output and its report.
    const again = spawnSync('sh', [filterScript, input], { encoding: 'utf8' });
    assert.equal(again.status, 0, again.stderr);
    assert.equal(again.stdout, report);
  },
);

test(
  'regenerates a routing input written by the earlier filter policy',
  { skip: !hasOsmium && 'osmium is not installed' },
  async (context) => {
    const directory = await mkdtemp(join(tmpdir(), 'navoss-filter-routing-'));
    context.after(() => rm(directory, { force: true, recursive: true }));
    const opl = join(directory, 'fixture.opl');
    const input = join(directory, 'north-261114.osm.pbf');
    const output = join(directory, 'north-261114.routing.osm.pbf');
    await writeFile(opl, extract);
    osmium('cat', '--overwrite', '--output', input, opl);
    // What policy 1 left behind: the ice road back in, and a report that counted it as removed.
    osmium('cat', '--overwrite', '--output', output, opl);
    await writeFile(
      join(directory, 'north-261114.routing.removed.txt'),
      'Removed 2 seasonal or ice-road ways (w/ice_road=yes,y) from north-261114.osm.pbf\n',
    );

    const result = spawnSync('sh', [filterScript, input], { encoding: 'utf8' });

    assert.equal(result.status, 0, result.stderr);
    const ways = osmium('cat', '--output-format', 'opl', output).match(/^w\d+/gmu) ?? [];
    assert.deepEqual(ways, ['w11']);
    assert.match(result.stdout, /\[routing filter 2\]/u);
  },
);

test(
  'writes no routing input whose ways reference missing nodes',
  { skip: !hasOsmium && 'osmium is not installed' },
  async (context) => {
    const directory = await mkdtemp(join(tmpdir(), 'navoss-filter-routing-'));
    context.after(() => rm(directory, { force: true, recursive: true }));
    const opl = join(directory, 'fixture.opl');
    const input = join(directory, 'north-261114.osm.pbf');
    await writeFile(opl, `${extract}w13 v1 Thighway=residential Nn1,n99\n`);
    osmium('cat', '--overwrite', '--output', input, opl);

    const result = spawnSync('sh', [filterScript, input], { encoding: 'utf8' });

    assert.equal(result.status, 1);
    assert.match(result.stderr, /ways reference missing nodes; nothing written/u);
    const written = spawnSync('ls', [directory], { encoding: 'utf8' }).stdout;
    assert.doesNotMatch(written, /routing/u);
  },
);
