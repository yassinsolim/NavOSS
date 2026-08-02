import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const profileScript = join(repositoryRoot, 'infra/compose/prepare-valhalla-speeds.sh');

const serviceFields = {
  alley: 10,
  driveway: 10,
  'drive-through': 9,
  parking_aisle: 11,
};

function context(way) {
  return {
    ...serviceFields,
    link_exiting: [62, 34, 33, 30, 23],
    link_turning: [60, 24, 19, 17, 17],
    roundabout: [24, 21, 19, 19, 19, 19, 16, 13],
    way,
  };
}

async function createFixture() {
  const fixture = await mkdtemp(join(tmpdir(), 'navoss-valhalla-speeds-'));
  const dataDirectory = join(fixture, 'data');
  const source = join(fixture, 'source.json');
  const globalUrban = context([85, 35, 27, 25, 23, 17, 15, 10]);
  const profiles = [
    {
      rural: context([99, 62, 51, 44, 33, 23, 16, 8]),
      suburban: context([93, 46, 36, 32, 28, 20, 16, 9]),
      urban: globalUrban,
    },
    {
      'iso3166-1': 'CA',
      'iso3166-2': 'AB',
      rural: context([101, 104, 95, 73, 44, 46, 23, 10]),
      suburban: context([88, 50, 46, 45, 33, 27, 20, 11]),
      urban: context([77, 50, 43, 39, 31, 22, 20, 11]),
    },
    {
      'iso3166-1': 'CA',
      'iso3166-2': 'BC',
      rural: context([102, 84, 64, 47, 39, 24, 22, 10]),
      suburban: context([82, 47, 37, 35, 31, 21, 18, 11]),
      urban: context([76, 36, 32, 31, 31, 21, 17, 10]),
    },
  ];
  const sourceText = `${JSON.stringify(profiles)}\n`;
  await mkdir(dataDirectory);
  await writeFile(source, sourceText);
  await chmod(profileScript, 0o755);
  return {
    dataDirectory,
    fixture,
    globalUrban,
    profiles,
    sourceHash: createHash('sha256').update(sourceText).digest('hex'),
    sourceUrl: pathToFileURL(source).href,
  };
}

function runProfile(fixture, expectedHash = fixture.sourceHash) {
  return spawnSync('sh', [profileScript, fixture.dataDirectory], {
    encoding: 'utf8',
    env: {
      ...process.env,
      VALHALLA_DEFAULT_SPEEDS_SHA256: expectedHash,
      VALHALLA_DEFAULT_SPEEDS_URL: fixture.sourceUrl,
    },
  });
}

test('generates only the validated Alberta hybrid and is idempotent', async (context) => {
  const fixture = await createFixture();
  context.after(() => rm(fixture.fixture, { force: true, recursive: true }));

  const first = runProfile(fixture);
  const firstOutput = await readFile(join(fixture.dataDirectory, 'default_speeds.json'), 'utf8');
  const second = runProfile(fixture);
  const secondOutput = await readFile(join(fixture.dataDirectory, 'default_speeds.json'), 'utf8');
  const generated = JSON.parse(firstOutput);
  const alberta = generated.find((profile) => profile['iso3166-2'] === 'AB');
  const britishColumbia = generated.find((profile) => profile['iso3166-2'] === 'BC');

  assert.equal(first.status, 0, first.stderr);
  assert.equal(second.status, 0, second.stderr);
  assert.deepEqual(alberta.rural, fixture.profiles[1].rural);
  assert.deepEqual(alberta.suburban, fixture.profiles[1].suburban);
  assert.deepEqual(alberta.urban, {
    ...fixture.globalUrban,
    way: [85, 50, 27, 25, 23, 17, 15, 10],
  });
  assert.deepEqual(britishColumbia, fixture.profiles[2]);
  assert.equal(secondOutput, firstOutput);
  assert.match(
    await readFile(join(fixture.dataDirectory, 'default_speeds.provenance'), 'utf8'),
    new RegExp(`source_sha256=${fixture.sourceHash}`),
  );
});

test('rejects an unexpected source without replacing an existing profile', async (context) => {
  const fixture = await createFixture();
  context.after(() => rm(fixture.fixture, { force: true, recursive: true }));
  await writeFile(join(fixture.dataDirectory, 'default_speeds.json'), 'keep-existing-profile\n');

  const result = runProfile(fixture, '0'.repeat(64));

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /source hash mismatch/);
  assert.equal(
    await readFile(join(fixture.dataDirectory, 'default_speeds.json'), 'utf8'),
    'keep-existing-profile\n',
  );
});
