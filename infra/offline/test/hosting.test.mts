import assert from 'node:assert/strict';
import { test } from 'node:test';

import { CACHE_LIMIT_BYTES, oversizedArtifacts, wafExpression, wafRule } from '../hosting.mts';

const HOST = 'https://navoss-offline.yassin.app';

function manifest(version: string, regions: string[], mapsBytes = 38_084_635) {
  return {
    regions: regions.map((id) => ({
      id,
      artifacts: {
        maps: { url: `${HOST}/${version}/regions/${id}/maps.pmtiles`, byteSize: mapsBytes },
        routing: { url: `${HOST}/${version}/regions/${id}/routing.tar`, byteSize: 99_164_160 },
        search: { url: `${HOST}/${version}/regions/${id}/search.sqlite`, byteSize: 147_111_936 },
        resources: { url: `${HOST}/${version}/resources.tar.gz`, byteSize: 61_597_437 },
      },
    })),
  };
}

const V1 = '2026-11-11-v1-798f5c442644';

// The rule applied to yassin.app on 2026-11-15 (first with GET/HEAD, then GET only), written
// independently of this helper.
const APPLIED =
  '(http.host eq "navoss-offline.yassin.app" and (not http.request.uri.path in {' +
  '"/2026-11-11-v1-798f5c442644/regions/alberta/maps.pmtiles" ' +
  '"/2026-11-11-v1-798f5c442644/regions/alberta/routing.tar" ' +
  '"/2026-11-11-v1-798f5c442644/regions/alberta/search.sqlite" ' +
  '"/2026-11-11-v1-798f5c442644/resources.tar.gz" ' +
  '"/2026-11-11-v1-798f5c442644/regions/calgary/maps.pmtiles" ' +
  '"/2026-11-11-v1-798f5c442644/regions/calgary/routing.tar" ' +
  '"/2026-11-11-v1-798f5c442644/regions/calgary/search.sqlite"} ' +
  'or http.request.uri.query ne "" or http.request.method ne "GET"))';

test('the expression for the published manifest is the rule applied to the zone', () => {
  assert.equal(wafExpression([manifest(V1, ['alberta', 'calgary'])]), APPLIED);
  assert.deepEqual(wafRule([manifest(V1, ['alberta', 'calgary'])]), {
    description: 'navoss-offline: only published files, GET, no query',
    expression: APPLIED,
    action: 'block',
    enabled: true,
  });
});

test('old and new manifests together allow both releases, each path once', () => {
  const expression = wafExpression([
    manifest(V1, ['calgary']),
    manifest('2026-12-01-v1-aaaaaaaaaaaa', ['calgary']),
  ]);
  for (const version of [V1, '2026-12-01-v1-aaaaaaaaaaaa'])
    assert.ok(expression.includes(`"/${version}/regions/calgary/maps.pmtiles"`));
  assert.equal(expression.split('resources.tar.gz').length - 1, 2);
});

test('unsafe or inconsistent URLs are refused rather than written into a rule', () => {
  const withUrl = (url: string) => ({
    regions: [{ artifacts: { maps: { url, byteSize: 1 } } }],
  });
  assert.throws(
    () => wafExpression([withUrl('http://navoss-offline.yassin.app/a')]),
    /plain HTTPS/,
  );
  assert.throws(() => wafExpression([withUrl(`${HOST}/a?x=1`)]), /plain HTTPS/);
  assert.throws(() => wafExpression([withUrl(`${HOST}/a"b`)]), /Unexpected path/);
  assert.throws(
    () =>
      wafExpression([
        manifest(V1, ['calgary']),
        { regions: [{ artifacts: { maps: { url: 'https://other.example/a', byteSize: 1 } } }] },
      ]),
    /share one host/,
  );
  assert.throws(() => wafExpression([{ regions: [] }]), /no regions/);
  assert.throws(
    () => wafExpression([{ regions: [{ artifacts: { maps: {} } }] }]),
    /url and byteSize/,
  );
});

test('artifacts above 512 MiB are reported, the measured 524,743,452-byte file is not', () => {
  assert.equal(CACHE_LIMIT_BYTES, 536_870_912);
  assert.deepEqual(oversizedArtifacts([manifest(V1, ['alberta'], 524_743_452)]), []);
  assert.deepEqual(oversizedArtifacts([manifest(V1, ['alberta'], CACHE_LIMIT_BYTES + 1)]), [
    { url: `${HOST}/${V1}/regions/alberta/maps.pmtiles`, byteSize: CACHE_LIMIT_BYTES + 1 },
  ]);
});
