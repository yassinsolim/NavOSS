import { createRequire } from 'node:module';

import { expect, it } from 'vitest';

const require = createRequire(import.meta.url);

/** `[major, minor, patch]` of a plain `x.y.z` version; prerelease tags are rejected. */
function parseVersion(version: string): [number, number, number] {
  const match = /^(\d+)\.(\d+)\.(\d+)$/u.exec(version);
  if (match === null) throw new Error(`Unexpected version ${version}`);
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function atLeast(version: string, minimum: string): boolean {
  const have = parseVersion(version);
  const need = parseVersion(minimum);
  for (let index = 0; index < 3; index += 1) {
    const difference = (have[index] ?? 0) - (need[index] ?? 0);
    if (difference !== 0) return difference > 0;
  }
  return true;
}

// Reanimated before 4.5.3 (4.x line) could evict a settled animated value before syncing it
// back to React when the JS thread stalled for about a second (software-mansion/
// react-native-reanimated#9965, fixed by #9527). The next React commit then put the view back
// to its mount-time style: the explore sheet (mounted with opacity 0) and the floating map
// controls vanished after Map appearance → Offline maps → close while their shared values were
// still correct (build 81 validation, D1). The shared-value state lives in Reanimated's native
// registry, so the guard is on the resolved package the app bundles and links.
it('bundles a Reanimated that keeps settled sheet positions across a JS stall', () => {
  const { version } = require('react-native-reanimated/package.json') as { version: string };
  expect(atLeast(version, '4.5.3'), `react-native-reanimated ${version}`).toBe(true);
});

it('compares versions numerically', () => {
  expect(atLeast('4.5.3', '4.5.3')).toBe(true);
  expect(atLeast('4.5.10', '4.5.3')).toBe(true);
  expect(atLeast('4.6.0', '4.5.3')).toBe(true);
  expect(atLeast('4.5.0', '4.5.3')).toBe(false);
  expect(atLeast('3.19.9', '4.5.3')).toBe(false);
});
