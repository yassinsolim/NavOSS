import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import {
  decide,
  DEFAULT_STOP,
  main,
  parseCredentials,
  parseState,
  stop,
  type GuardState,
  type Observation,
} from '../r2-guard.mts';
import { listBucket } from '../r2-analytics.mts';

const NOW = new Date('2026-11-20T12:00:00Z');
const LIMITS = { ...DEFAULT_STOP };
const FRESH: GuardState = { failures: 0 };

function serving(overrides: Partial<Observation> = {}): Observation {
  return {
    operations: { classA: 12, classB: 5_000, current: true },
    bytes: 1_452_230_980,
    domainEnabled: true,
    devUrlEnabled: false,
    errors: [],
    ...overrides,
  };
}

test('within every threshold it changes nothing and resets the failure count', () => {
  const decision = decide(serving(), { failures: 3 }, LIMITS, 4, NOW);
  assert.equal(decision.action, 'none');
  assert.equal(decision.exitCode, 0);
  assert.deepEqual(decision.next, { failures: 0 });
});

test('each threshold stops hosting on its own, and only above it', () => {
  const cases: [Partial<Observation>, RegExp][] = [
    [{ operations: { classA: 0, classB: 2_000_001, current: true } }, /Class B operations/],
    [{ operations: { classA: 200_001, classB: 0, current: true } }, /Class A operations/],
    [{ bytes: 5e9 + 1 }, /stored bytes/],
  ];
  for (const [overrides, pattern] of cases) {
    const decision = decide(serving(overrides), FRESH, LIMITS, 4, NOW);
    assert.equal(decision.action, 'stop');
    assert.equal(decision.exitCode, 1);
    assert.match(decision.reason, pattern);
    assert.equal(decision.next.stoppedAt, NOW.toISOString());
  }
  const atLimit = decide(
    serving({ operations: { classA: 200_000, classB: 2_000_000, current: true }, bytes: 5e9 }),
    FRESH,
    LIMITS,
    4,
    NOW,
  );
  assert.equal(atLimit.action, 'none');
});

test('an established stop condition is acted on even when other reads failed', () => {
  // Counts above a threshold, domain state unknown: stop now, not after the grace runs.
  const overDomainUnknown = decide(
    {
      operations: { classA: 0, classB: 2_500_000, current: false },
      errors: ['Cloudflare API 500 for GET /accounts/…/domains/custom'],
    },
    FRESH,
    LIMITS,
    4,
    NOW,
  );
  assert.equal(overDomainUnknown.action, 'stop');
  assert.match(overDomainUnknown.reason, /Class B operations 2500000 above 2000000/);
  // r2.dev enabled while analytics failed: stop now.
  const devUrl = decide(
    { domainEnabled: true, devUrlEnabled: true, errors: ['analytics failed'] },
    FRESH,
    LIMITS,
    4,
    NOW,
  );
  assert.equal(devUrl.action, 'stop');
  assert.match(devUrl.reason, /r2\.dev URL is enabled/);
  // Storage over the threshold from the listing while analytics failed: stop now.
  const bytes = decide({ bytes: 6e9, errors: ['analytics failed'] }, FRESH, LIMITS, 4, NOW);
  assert.equal(bytes.action, 'stop');
});

test('missing or unproven usage is never read as zero', () => {
  const unknowns: Observation[] = [
    { errors: ['Cloudflare API 500'] },
    // Zero operations without the previous heartbeat: possibly stale analytics, not an idle month.
    serving({ operations: { classA: 0, classB: 0, current: false } }),
    serving({ bytes: undefined }),
    serving({ domainEnabled: undefined }),
    serving({ devUrlEnabled: undefined }),
  ];
  for (const observation of unknowns) {
    let state = FRESH;
    for (let run = 1; run <= 3; run += 1) {
      const decision = decide(observation, state, LIMITS, 4, NOW);
      assert.equal(decision.action, 'none');
      assert.equal(decision.exitCode, 2);
      assert.equal(decision.next.failures, run);
      state = decision.next;
    }
    const fourth = decide(observation, state, LIMITS, 4, NOW);
    assert.equal(fourth.action, 'stop');
    assert.equal(fourth.exitCode, 1);
    assert.match(fourth.reason, /usage not established for 4 consecutive runs/);
  }
});

test('an idle month with a confirmed heartbeat is within limits, not a failure', () => {
  const decision = decide(
    serving({ operations: { classA: 0, classB: 0, current: true } }),
    { failures: 2 },
    LIMITS,
    4,
    NOW,
  );
  assert.equal(decision.action, 'none');
  assert.equal(decision.exitCode, 0);
  assert.equal(decision.next.failures, 0);
});

test('already stopped stays stopped and keeps the original stop time', () => {
  const state: GuardState = { failures: 0, stoppedAt: '2026-11-19T00:00:00Z', reason: 'x' };
  const over = decide(
    serving({ operations: { classA: 0, classB: 3_000_000, current: true }, domainEnabled: false }),
    state,
    LIMITS,
    4,
    NOW,
  );
  assert.equal(over.action, 'stop');
  assert.match(over.reason, /^already stopped since 2026-11-19T00:00:00Z/);
  assert.equal(over.next.stoppedAt, '2026-11-19T00:00:00Z');
  // Usage is low again (a new window): the guard still never re-enables hosting.
  const under = decide(serving({ domainEnabled: false }), state, LIMITS, 4, NOW);
  assert.equal(under.action, 'stop');
  assert.match(under.reason, /disabled since 2026-11-19T00:00:00Z \(x\); hosting stays stopped/);
});

test('a domain disabled by hand also withdraws the manifest', () => {
  const decision = decide(serving({ domainEnabled: false }), FRESH, LIMITS, 4, NOW);
  assert.equal(decision.action, 'stop');
  assert.match(decision.reason, /^custom domain is disabled; hosting stays stopped/);
});

test('an operator re-enabling hosting is accepted once usage is within limits', () => {
  const decision = decide(
    serving(),
    { failures: 0, stoppedAt: '2026-11-19T00:00:00Z', reason: 'x', heartbeatAt: 'h' },
    LIMITS,
    4,
    NOW,
  );
  assert.equal(decision.action, 'none');
  assert.deepEqual(decision.next, { failures: 0, heartbeatAt: 'h' });
});

test('state and credential files are validated', () => {
  assert.deepEqual(parseState(undefined), { failures: 0 });
  assert.deepEqual(parseState('{"failures":2,"stoppedAt":"t","reason":"r","heartbeatAt":"h"}'), {
    failures: 2,
    stoppedAt: 't',
    reason: 'r',
    heartbeatAt: 'h',
  });
  assert.throws(() => parseState('{"failures":-1}'), /Invalid guard state/);
  assert.throws(() => parseState('{"failures":'), SyntaxError);
  assert.deepEqual(
    parseCredentials('# comment\nCLOUDFLARE_API_TOKEN=abc\nCLOUDFLARE_ACCOUNT_ID="def"\n'),
    {
      CLOUDFLARE_API_TOKEN: 'abc',
      CLOUDFLARE_ACCOUNT_ID: 'def',
    },
  );
});

interface Call {
  method: string;
  path: string;
}

async function withFetch<T>(
  answer: (call: Call) => unknown,
  run: (calls: Call[]) => Promise<T>,
): Promise<T> {
  const original = globalThis.fetch;
  const calls: Call[] = [];
  globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
    const call = { method: init?.method ?? 'GET', path: new URL(String(input)).pathname };
    calls.push(call);
    return new Response(JSON.stringify({ success: true, errors: [], result: answer(call) }), {
      status: 200,
    });
  }) as typeof fetch;
  try {
    return await run(calls);
  } finally {
    globalThis.fetch = original;
  }
}

test('a manifest error never prevents disabling the domain and r2.dev, which are re-read', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'navoss-r2-guard-'));
  const notADirectory = join(directory, 'file');
  await writeFile(notADirectory, 'x');
  try {
    const error = await withFetch(
      () => ({ enabled: false }),
      async (calls) => {
        const failure = await stop({
          token: 't',
          account: 'a',
          bucket: 'navoss-offline',
          domain: 'navoss-offline.yassin.app',
          manifestDirectory: notADirectory,
          dryRun: false,
        }).catch((caught: Error) => caught);
        assert.deepEqual(
          calls.map(
            ({ method, path }) =>
              `${method} ${path.replace('/client/v4/accounts/a/r2/buckets/navoss-offline/domains/', '')}`,
          ),
          [
            'PUT custom/navoss-offline.yassin.app',
            'GET custom/navoss-offline.yassin.app',
            'PUT managed',
            'GET managed',
          ],
        );
        return failure;
      },
    );
    assert.ok(error instanceof Error);
    assert.match(
      error.message,
      /disable navoss-offline\.yassin\.app; disable r2\.dev; FAILED: move manifest\.json/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('a domain still enabled after the disable request is a failed stop', async () => {
  await withFetch(
    ({ path }) => ({ enabled: path.endsWith('/managed') ? false : true }),
    async () => {
      await assert.rejects(
        stop({ token: 't', account: 'a', bucket: 'b', domain: 'd.example', dryRun: false }),
        /FAILED: disable d\.example: custom domain still enabled after the request/,
      );
    },
  );
});

async function scratch() {
  const directory = await mkdtemp(join(tmpdir(), 'navoss-r2-guard-'));
  await writeFile(join(directory, 'manifest.json'), '{}');
  return directory;
}

async function quietly<T>(run: (errors: string[]) => Promise<T>): Promise<T> {
  const saved = {
    token: process.env.CLOUDFLARE_API_TOKEN,
    account: process.env.CLOUDFLARE_ACCOUNT_ID,
  };
  delete process.env.CLOUDFLARE_API_TOKEN;
  delete process.env.CLOUDFLARE_ACCOUNT_ID;
  const errors: string[] = [];
  const original = { error: console.error, log: console.log };
  console.error = (line: string) => errors.push(line);
  console.log = (line: string) => errors.push(line);
  try {
    return await run(errors);
  } finally {
    console.error = original.error;
    console.log = original.log;
    if (saved.token !== undefined) process.env.CLOUDFLARE_API_TOKEN = saved.token;
    if (saved.account !== undefined) process.env.CLOUDFLARE_ACCOUNT_ID = saved.account;
  }
}

test('without credentials, four runs withdraw the manifest; state is replaced atomically', async () => {
  const directory = await scratch();
  try {
    await quietly(async (errors) => {
      const statePath = join(directory, 'state.json');
      const args = ['--state', statePath, '--manifest-dir', directory];
      let inode: number | undefined;
      for (let run = 1; run <= 3; run += 1) {
        assert.equal(await main(args), 2);
        assert.equal(JSON.parse(await readFile(statePath, 'utf8')).failures, run);
        const current = (await stat(statePath)).ino;
        if (inode !== undefined) assert.notEqual(current, inode, 'state is renamed into place');
        inode = current;
      }
      assert.equal(await main([...args, '--dry-run']), 1);
      assert.match(errors.at(-1)!, /^dry run: STOP INCOMPLETE: .*would move manifest/);
      assert.ok((await readdir(directory)).includes('manifest.json'));
      assert.equal(JSON.parse(await readFile(statePath, 'utf8')).failures, 3);
      assert.equal(await main(args), 1);
      const files = await readdir(directory);
      assert.ok(files.includes('manifest.json.stopped') && !files.includes('manifest.json'));
      assert.ok(!files.some((name) => name.endsWith('.tmp')));
      assert.match(
        errors.at(-1)!,
        /^STOP INCOMPLETE: usage not established for 4 consecutive runs/,
      );
      assert.match(errors.at(-1)!, /public access could not be disabled/);
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('a malformed state file stops hosting at once and is replaced by a valid one', async () => {
  const directory = await scratch();
  try {
    await quietly(async (errors) => {
      const statePath = join(directory, 'state.json');
      await writeFile(statePath, '{"failures":');
      assert.equal(await main(['--state', statePath, '--manifest-dir', directory]), 1);
      assert.match(errors.at(-1)!, /state file unreadable/);
      assert.ok((await readdir(directory)).includes('manifest.json.stopped'));
      assert.ok(parseState(await readFile(statePath, 'utf8')).stoppedAt);
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('a state file that cannot be written stops hosting at once', async () => {
  const directory = await scratch();
  try {
    await quietly(async (errors) => {
      // The state's parent is a regular file, so the state can never be written.
      const blocker = join(directory, 'blocker');
      await writeFile(blocker, 'x');
      assert.equal(
        await main(['--state', join(blocker, 'state.json'), '--manifest-dir', directory]),
        1,
      );
      assert.match(errors.at(-1)!, /state file not writable/);
      assert.ok((await readdir(directory)).includes('manifest.json.stopped'));
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('an already withdrawn manifest is not a failure', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'navoss-r2-guard-'));
  try {
    await withFetch(
      () => ({ enabled: false }),
      async () => {
        const done = await stop({
          token: 't',
          account: 'a',
          bucket: 'b',
          domain: 'd.example',
          manifestDirectory: directory,
          dryRun: false,
        });
        assert.equal(done[0], 'manifest.json already withdrawn');
      },
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

interface FakeCloudflare {
  /** Requests of the heartbeat action the analytics report since the reference time. */
  heartbeats: number;
  /** The main totals; by default PutObject 12 plus the heartbeats as ListObjects. */
  operations?: { actionType: string; requests: number }[];
  /** The listing's `result_info`. */
  resultInfo?: Record<string, unknown>;
}

/** A fake Cloudflare API: listing, analytics, domain states. */
async function withCloudflare<T>(fake: FakeCloudflare, run: () => Promise<T>): Promise<T> {
  const operations = fake.operations ?? [
    { actionType: 'PutObject', requests: 12 },
    ...(fake.heartbeats > 0 ? [{ actionType: 'ListObjects', requests: fake.heartbeats }] : []),
  ];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL) => {
    const url = new URL(String(input));
    const body = url.pathname.endsWith('/graphql')
      ? {
          data: {
            viewer: {
              accounts: [
                {
                  operations: operations.map(({ actionType, requests }) => ({
                    sum: { requests },
                    dimensions: { actionType },
                  })),
                  heartbeat: fake.heartbeats > 0 ? [{ sum: { requests: fake.heartbeats } }] : [],
                  storage: [],
                },
              ],
            },
          },
          errors: null,
        }
      : url.pathname.endsWith('/objects')
        ? {
            success: true,
            errors: [],
            result: [{ key: 'k', size: 1_000 }],
            result_info: fake.resultInfo ?? {},
          }
        : { success: true, errors: [], result: { enabled: !url.pathname.endsWith('/managed') } };
    return new Response(JSON.stringify(body), { status: 200 });
  }) as typeof fetch;
  try {
    return await run();
  } finally {
    globalThis.fetch = original;
  }
}

async function guardRun(directory: string) {
  const credentials = join(directory, 'guard.env');
  await writeFile(credentials, 'CLOUDFLARE_API_TOKEN=t\nCLOUDFLARE_ACCOUNT_ID=a\n');
  return [
    '--state',
    join(directory, 'state.json'),
    '--credentials',
    credentials,
    '--manifest-dir',
    directory,
  ];
}

test('zero-free analytics count only once the previous run’s heartbeat shows in them', async () => {
  const directory = await scratch();
  try {
    await quietly(async (lines) => {
      const statePath = join(directory, 'state.json');
      const args = await guardRun(directory);
      // First run: no earlier heartbeat can prove the analytics are current.
      assert.equal(await withCloudflare({ heartbeats: 1 }, () => main(args)), 2);
      assert.match(lines.at(-1)!, /heartbeat/);
      const first = parseState(await readFile(statePath, 'utf8'));
      assert.ok(first.heartbeatAt);
      // Five minutes later the analytics show it: within limits.
      const settled = new Date(Date.now() - 5 * 60_000).toISOString();
      await writeFile(statePath, JSON.stringify({ ...first, heartbeatAt: settled }));
      assert.equal(await withCloudflare({ heartbeats: 1 }, () => main(args)), 0);
      assert.match(lines.at(-1)!, /^within limits \(Class A 13, Class B 0, 1000 bytes\)/);
      // Analytics that do not show it are stale: unknown, never zero.
      await writeFile(statePath, JSON.stringify({ failures: 0, heartbeatAt: settled }));
      assert.equal(await withCloudflare({ heartbeats: 0 }, () => main(args)), 2);
      assert.ok((await readdir(directory)).includes('manifest.json'));
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('a heartbeat must be inside the totals the decision uses', async () => {
  const directory = await scratch();
  try {
    await quietly(async (lines) => {
      const args = await guardRun(directory);
      const settled = new Date(Date.now() - 5 * 60_000).toISOString();
      await writeFile(
        join(directory, 'state.json'),
        JSON.stringify({ failures: 0, heartbeatAt: settled }),
      );
      // The heartbeat query sees the listing, but the totals are empty: they are not current.
      assert.equal(await withCloudflare({ heartbeats: 1, operations: [] }, () => main(args)), 2);
      assert.match(lines.at(-1)!, /usage not established/);
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('a heartbeat reference older than three timer periods is discarded and renewed', async () => {
  const directory = await scratch();
  try {
    await quietly(async (lines) => {
      const args = await guardRun(directory);
      const statePath = join(directory, 'state.json');
      const old = new Date(Date.now() - 2 * 60 * 60_000).toISOString();
      await writeFile(statePath, JSON.stringify({ failures: 0, heartbeatAt: old }));
      // Analytics frozen at the old heartbeat would still "show" it: not enough after an outage.
      assert.equal(await withCloudflare({ heartbeats: 1 }, () => main(args)), 2);
      assert.match(lines.at(-1)!, /heartbeat/);
      const renewed = parseState(await readFile(statePath, 'utf8')).heartbeatAt!;
      assert.ok(Date.now() - new Date(renewed).getTime() < 60_000, 'a fresh heartbeat is recorded');
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('a truncated listing without a usable cursor is not a complete size', async () => {
  for (const resultInfo of [{ is_truncated: true }, { is_truncated: true, cursor: '' }]) {
    await withCloudflare({ heartbeats: 0, resultInfo }, async () => {
      await assert.rejects(listBucket('t', 'a', 'b'), /truncated listing without a cursor/);
    });
  }
  // A cursor-less, untruncated answer is complete.
  await withCloudflare({ heartbeats: 0, resultInfo: { is_truncated: false } }, async () => {
    assert.deepEqual(await listBucket('t', 'a', 'b'), { objects: 1, bytes: 1_000 });
  });
});
