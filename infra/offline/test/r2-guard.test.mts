import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import type { Usage } from '../r2-analytics.mts';
import {
  decide,
  DEFAULT_STOP,
  main,
  parseState,
  type GuardState,
  type Observation,
} from '../r2-guard.mts';

const NOW = new Date('2026-11-20T12:00:00Z');
const LIMITS = { ...DEFAULT_STOP };

function usage(overrides: Partial<Usage> = {}): Usage {
  return {
    bucketBytes: 1_452_230_980,
    bucketObjects: 9,
    accountBytes: 1_452_230_980,
    classA: 12,
    classB: 5_000,
    free: 0,
    unknownActions: [],
    ...overrides,
  };
}

function serving(overrides: Partial<Usage> = {}): Observation {
  return { usage: usage(overrides), domainEnabled: true, devUrlEnabled: false };
}

const FRESH: GuardState = { failures: 0 };

test('within every threshold it changes nothing and resets the failure count', () => {
  const decision = decide(serving(), { failures: 3 }, LIMITS, 4, NOW);
  assert.equal(decision.action, 'none');
  assert.equal(decision.exitCode, 0);
  assert.deepEqual(decision.next, { failures: 0 });
});

test('each threshold stops hosting on its own, and only above it', () => {
  const cases: [Partial<Usage>, string][] = [
    [{ classB: 2_000_001 }, 'Class B operations'],
    [{ classA: 200_001 }, 'Class A operations'],
    [{ accountBytes: 5e9 + 1 }, 'account bytes'],
    [{ bucketBytes: 5e9 + 1 }, 'bucket bytes'],
  ];
  for (const [overrides, name] of cases) {
    const decision = decide(serving(overrides), FRESH, LIMITS, 4, NOW);
    assert.equal(decision.action, 'stop', name);
    assert.equal(decision.exitCode, 1);
    assert.match(decision.reason, new RegExp(`${name} above the stop threshold`));
    assert.equal(decision.next.stoppedAt, NOW.toISOString());
  }
  const atLimit = decide(
    serving({ classA: 200_000, classB: 2_000_000, accountBytes: 5e9, bucketBytes: 5e9 }),
    FRESH,
    LIMITS,
    4,
    NOW,
  );
  assert.equal(atLimit.action, 'none');
});

test('a missing storage sample or failed request is never read as zero usage', () => {
  let state = FRESH;
  for (let run = 1; run <= 3; run += 1) {
    const decision = decide(
      { error: 'No storage sample for navoss-offline in the last 24 hours' },
      state,
      LIMITS,
      4,
      NOW,
    );
    assert.equal(decision.action, 'none');
    assert.equal(decision.exitCode, 2);
    assert.equal(decision.next.failures, run);
    state = decision.next;
  }
  const fourth = decide({ error: 'Cloudflare API 500' }, state, LIMITS, 4, NOW);
  assert.equal(fourth.action, 'stop');
  assert.equal(fourth.exitCode, 1);
  assert.match(fourth.reason, /usage unreadable for 4 consecutive runs: Cloudflare API 500/);
});

test('usage without the domain state counts as a failure, as does an incomplete answer', () => {
  const partial = decide({ usage: usage(), devUrlEnabled: false }, FRESH, LIMITS, 1, NOW);
  assert.equal(partial.action, 'stop');
  const noUsage = decide({ domainEnabled: true, devUrlEnabled: false }, FRESH, LIMITS, 2, NOW);
  assert.equal(noUsage.action, 'none');
  assert.equal(noUsage.next.failures, 1);
});

test('a successful read after failures clears the count', () => {
  const decision = decide(serving(), { failures: 3 }, LIMITS, 4, NOW);
  assert.equal(decision.next.failures, 0);
});

test('an enabled r2.dev URL is a stop reason even within limits', () => {
  const decision = decide({ ...serving(), devUrlEnabled: true }, FRESH, LIMITS, 4, NOW);
  assert.equal(decision.action, 'stop');
  assert.match(decision.reason, /r2\.dev URL is enabled/);
});

test('already stopped stays stopped and keeps the original stop time', () => {
  const state: GuardState = { failures: 0, stoppedAt: '2026-11-19T00:00:00Z', reason: 'x' };
  const over = decide(
    { usage: usage({ classB: 3_000_000 }), domainEnabled: false, devUrlEnabled: false },
    state,
    LIMITS,
    4,
    NOW,
  );
  assert.equal(over.action, 'stop');
  assert.equal(over.exitCode, 1);
  assert.match(over.reason, /^already stopped since 2026-11-19T00:00:00Z/);
  assert.equal(over.next.stoppedAt, '2026-11-19T00:00:00Z');
  // The month rolled over and usage is low again: the guard still never re-enables hosting.
  const under = decide(
    { usage: usage(), domainEnabled: false, devUrlEnabled: false },
    state,
    LIMITS,
    4,
    NOW,
  );
  assert.equal(under.action, 'stop');
  assert.match(under.reason, /disabled since 2026-11-19T00:00:00Z \(x\); hosting stays stopped/);
});

test('a domain disabled by hand also withdraws the manifest', () => {
  const decision = decide(
    { usage: usage(), domainEnabled: false, devUrlEnabled: false },
    FRESH,
    LIMITS,
    4,
    NOW,
  );
  assert.equal(decision.action, 'stop');
  assert.match(decision.reason, /^custom domain is disabled; hosting stays stopped/);
});

test('an operator re-enabling hosting is accepted once usage is within limits', () => {
  const decision = decide(
    serving(),
    { failures: 0, stoppedAt: '2026-11-19T00:00:00Z', reason: 'x' },
    LIMITS,
    4,
    NOW,
  );
  assert.equal(decision.action, 'none');
  assert.deepEqual(decision.next, { failures: 0 });
});

test('state files are validated', () => {
  assert.deepEqual(parseState(undefined), { failures: 0 });
  assert.deepEqual(parseState('{"failures":2,"stoppedAt":"t","reason":"r"}'), {
    failures: 2,
    stoppedAt: 't',
    reason: 'r',
  });
  assert.throws(() => parseState('{"failures":-1}'), /Invalid guard state/);
  assert.throws(() => parseState('[]'), /Invalid guard state/);
});

test('without credentials, four runs withdraw the manifest and report what could not be done', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'navoss-r2-guard-'));
  const saved = {
    token: process.env.CLOUDFLARE_API_TOKEN,
    account: process.env.CLOUDFLARE_ACCOUNT_ID,
  };
  delete process.env.CLOUDFLARE_API_TOKEN;
  delete process.env.CLOUDFLARE_ACCOUNT_ID;
  const errors: string[] = [];
  const originalError = console.error;
  console.error = (line: string) => errors.push(line);
  try {
    await writeFile(join(directory, 'manifest.json'), '{}');
    const args = ['--state', join(directory, 'state.json'), '--manifest-dir', directory];
    for (let run = 1; run <= 3; run += 1) {
      assert.equal(await main(args), 2);
      assert.deepEqual(JSON.parse(await readFile(join(directory, 'state.json'), 'utf8')), {
        failures: run,
      });
    }
    // A dry run reports the stop it would make but neither moves the manifest nor advances the count.
    assert.equal(await main([...args, '--dry-run']), 1);
    assert.match(
      errors.at(-1)!,
      /^dry run: STOP INCOMPLETE: usage unreadable for 4 consecutive runs.*would move manifest/,
    );
    assert.ok((await readdir(directory)).includes('manifest.json'));
    assert.equal(JSON.parse(await readFile(join(directory, 'state.json'), 'utf8')).failures, 3);
    assert.equal(await main(args), 1);
    const files = await readdir(directory);
    assert.ok(files.includes('manifest.json.stopped'));
    assert.ok(!files.includes('manifest.json'));
    assert.match(errors.at(-1)!, /^STOP INCOMPLETE: usage unreadable for 4 consecutive runs/);
    assert.match(errors.at(-1)!, /move manifest\.json to manifest\.json\.stopped/);
    assert.match(errors.at(-1)!, /public access could not be disabled/);
    // Later runs keep it withdrawn and keep failing loudly.
    assert.equal(await main(args), 1);
    assert.ok(!(await readdir(directory)).includes('manifest.json'));
  } finally {
    console.error = originalError;
    if (saved.token !== undefined) process.env.CLOUDFLARE_API_TOKEN = saved.token;
    if (saved.account !== undefined) process.env.CLOUDFLARE_ACCOUNT_ID = saved.account;
    await rm(directory, { recursive: true, force: true });
  }
});
