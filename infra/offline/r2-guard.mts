// Automatic stop for offline bundle hosting. Every run reads this month's R2 operations and the
// stored bytes from Cloudflare's analytics. Above a stop threshold, after repeated failures to
// read them, or when the public r2.dev URL is on, it disables public access to the bucket and
// takes the manifest out of service, so the API answers the quiet "not available" 503 again. It
// never re-enables anything; see infra/offline/README.md ("Automatic stop").
//
// Runs with plain Node 24 (type stripping) on the VM: node infra/offline/r2-guard.mts
// Exit status: 0 serving within limits, 1 stopped (now or earlier), 2 could not observe (not yet
// stopped), 3 usage error.
import { readFile, rename, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

import {
  cloudflare,
  exceededLimits,
  isRecord,
  readUsage,
  type Usage,
  type UsageLimits,
} from './r2-analytics.mts';

export const DEFAULT_STOP = { classA: 200_000, classB: 2_000_000, bytes: 5e9 } as const;
export const DEFAULT_MAX_FAILURES = 4;
const MANIFEST = 'manifest.json';
const STOPPED_MANIFEST = 'manifest.json.stopped';

export interface GuardState {
  /** Consecutive runs that could not read analytics or the domain state. */
  failures: number;
  /** When and why this guard last stopped hosting. */
  stoppedAt?: string;
  reason?: string;
}

/** One run's view of Cloudflare; any field may be missing when its request failed. */
export interface Observation {
  usage?: Usage;
  /** Whether the custom domain serves the bucket publicly. */
  domainEnabled?: boolean;
  /** Whether the bucket's managed r2.dev URL is public. */
  devUrlEnabled?: boolean;
  /** Why some part could not be read. */
  error?: string;
}

export interface Decision {
  /** `stop` disables public access and withdraws the manifest; `none` changes nothing. */
  action: 'stop' | 'none';
  exitCode: 0 | 1 | 2;
  reason: string;
  next: GuardState;
}

export function decide(
  observation: Observation,
  state: GuardState,
  limits: Omit<UsageLimits, 'objects'>,
  maxFailures: number,
  now: Date,
): Decision {
  const complete =
    observation.usage !== undefined &&
    observation.domainEnabled !== undefined &&
    observation.devUrlEnabled !== undefined &&
    observation.error === undefined;
  if (!complete) {
    const failures = state.failures + 1;
    const why = observation.error ?? 'incomplete answer';
    if (failures < maxFailures) {
      // Unknown is never zero, but one missed reading is not yet a reason to stop.
      return {
        action: 'none',
        exitCode: 2,
        reason: `could not read usage (${failures}/${maxFailures} before stopping): ${why}`,
        next: { ...state, failures },
      };
    }
    const reason = `usage unreadable for ${failures} consecutive runs: ${why}`;
    return { action: 'stop', exitCode: 1, reason, next: stopped(state, failures, reason, now) };
  }
  const usage = observation.usage!;
  const exceeded = exceededLimits(usage, { ...limits, objects: Number.MAX_SAFE_INTEGER });
  const reasons = [
    ...exceeded.map((name) => `${name} above the stop threshold`),
    ...(observation.devUrlEnabled ? ['the public r2.dev URL is enabled'] : []),
  ];
  if (reasons.length > 0) {
    const detail =
      `${reasons.join('; ')} (Class A ${usage.classA}, Class B ${usage.classB}, ` +
      `${usage.accountBytes} bytes)`;
    if (!observation.domainEnabled && !observation.devUrlEnabled && state.stoppedAt)
      return {
        action: 'stop', // idempotent: keeps the manifest withdrawn
        exitCode: 1,
        reason: `already stopped since ${state.stoppedAt}: ${detail}`,
        next: { ...state, failures: 0 },
      };
    return { action: 'stop', exitCode: 1, reason: detail, next: stopped(state, 0, detail, now) };
  }
  if (!observation.domainEnabled) {
    // Disabled by this guard earlier or by hand: never offer downloads that cannot succeed.
    const since = state.stoppedAt ? ` since ${state.stoppedAt} (${state.reason})` : '';
    return {
      action: 'stop',
      exitCode: 1,
      reason: `custom domain is disabled${since}; hosting stays stopped until re-enabled by hand`,
      next: { ...state, failures: 0 },
    };
  }
  // Serving and within limits. An earlier stop record means an operator re-enabled hosting.
  return {
    action: 'none',
    exitCode: 0,
    reason: `within limits (Class A ${usage.classA}, Class B ${usage.classB}, ${usage.accountBytes} bytes)`,
    next: { failures: 0 },
  };
}

function stopped(state: GuardState, failures: number, reason: string, now: Date): GuardState {
  return { ...state, failures, stoppedAt: now.toISOString(), reason };
}

export function parseState(text: string | undefined): GuardState {
  if (text === undefined) return { failures: 0 };
  const value: unknown = JSON.parse(text);
  if (!isRecord(value) || typeof value.failures !== 'number' || value.failures < 0)
    throw new Error('Invalid guard state file');
  return {
    failures: value.failures,
    ...(typeof value.stoppedAt === 'string' ? { stoppedAt: value.stoppedAt } : {}),
    ...(typeof value.reason === 'string' ? { reason: value.reason } : {}),
  };
}

function domainPath(account: string, bucket: string, kind: string): string {
  return `/accounts/${account}/r2/buckets/${encodeURIComponent(bucket)}/domains/${kind}`;
}

async function observe(token: string, account: string, bucket: string, domain: string) {
  const observation: Observation = {};
  const errors: string[] = [];
  try {
    observation.usage = await readUsage(token, account, bucket);
  } catch (error) {
    errors.push(error instanceof Error ? error.message : 'analytics failed');
  }
  try {
    const custom = await cloudflare(token, `${domainPath(account, bucket, 'custom')}/${domain}`);
    if (!isRecord(custom) || typeof custom.enabled !== 'boolean')
      throw new Error('Unexpected custom domain answer');
    observation.domainEnabled = custom.enabled;
    const managed = await cloudflare(token, domainPath(account, bucket, 'managed'));
    if (!isRecord(managed) || typeof managed.enabled !== 'boolean')
      throw new Error('Unexpected r2.dev answer');
    observation.devUrlEnabled = managed.enabled;
  } catch (error) {
    errors.push(error instanceof Error ? error.message : 'domain state failed');
  }
  if (errors.length > 0) observation.error = errors.join('; ');
  return observation;
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (isRecord(error) && error.code === 'ENOENT') return false;
    throw error;
  }
}

/** Disables public access and withdraws the manifest; each step is attempted independently. */
async function stop(
  token: string | undefined,
  account: string | undefined,
  bucket: string,
  domain: string,
  manifestDirectory: string | undefined,
  dryRun: boolean,
): Promise<string[]> {
  const done: string[] = [];
  const failed: string[] = [];
  const step = async (what: string, action: () => Promise<void>) => {
    if (dryRun) {
      done.push(`would ${what}`);
      return;
    }
    try {
      await action();
      done.push(what);
    } catch (error) {
      failed.push(`${what}: ${error instanceof Error ? error.message : 'failed'}`);
    }
  };
  if (manifestDirectory) {
    const live = join(manifestDirectory, MANIFEST);
    // The API reads the manifest per request, so the next request answers the quiet 503.
    if (await exists(live))
      await step(`move ${MANIFEST} to ${STOPPED_MANIFEST}`, () =>
        rename(live, join(manifestDirectory, STOPPED_MANIFEST)),
      );
  }
  if (token && account) {
    await step(`disable ${domain}`, async () => {
      await cloudflare(
        token,
        `${domainPath(account, bucket, 'custom')}/${domain}`,
        {
          enabled: false,
        },
        'PUT',
      );
    });
    await step('keep r2.dev disabled', async () => {
      await cloudflare(token, domainPath(account, bucket, 'managed'), { enabled: false }, 'PUT');
    });
  } else {
    failed.push('no Cloudflare credentials: public access could not be disabled');
  }
  if (failed.length > 0) throw new Error(`${done.join('; ')}; FAILED: ${failed.join('; ')}`);
  return done;
}

export async function main(args: string[]): Promise<number> {
  const { values } = parseArgs({
    args,
    options: {
      bucket: { type: 'string', default: 'navoss-offline' },
      domain: { type: 'string', default: 'navoss-offline.yassin.app' },
      state: { type: 'string' },
      'manifest-dir': { type: 'string' },
      'stop-class-a': { type: 'string', default: String(DEFAULT_STOP.classA) },
      'stop-class-b': { type: 'string', default: String(DEFAULT_STOP.classB) },
      'stop-bytes': { type: 'string', default: String(DEFAULT_STOP.bytes) },
      'max-failures': { type: 'string', default: String(DEFAULT_MAX_FAILURES) },
      'dry-run': { type: 'boolean', default: false },
    },
  });
  const limits = {
    classA: Number(values['stop-class-a']),
    classB: Number(values['stop-class-b']),
    bytes: Number(values['stop-bytes']),
  };
  const maxFailures = Number(values['max-failures']);
  if (
    [...Object.values(limits), maxFailures].some((value) => !Number.isFinite(value) || value < 0) ||
    !Number.isInteger(maxFailures) ||
    maxFailures < 1
  ) {
    console.error('Thresholds must be non-negative numbers and --max-failures a positive integer');
    return 3;
  }
  if (!values.state && !values['dry-run']) {
    console.error('--state FILE is required (it counts consecutive failures)');
    return 3;
  }
  const token = process.env.CLOUDFLARE_API_TOKEN;
  const account = process.env.CLOUDFLARE_ACCOUNT_ID;
  const statePath = values.state;
  const state = parseState(
    statePath && (await exists(statePath)) ? await readFile(statePath, 'utf8') : undefined,
  );
  const observation: Observation =
    token && account
      ? await observe(token, account, values.bucket, values.domain)
      : { error: 'CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID are required' };
  const decision = decide(observation, state, limits, maxFailures, new Date());
  const prefix = values['dry-run'] ? 'dry run: ' : '';
  let exitCode: number = decision.exitCode;
  let line = decision.reason;
  if (decision.action === 'stop') {
    try {
      const done = await stop(
        token,
        account,
        values.bucket,
        values.domain,
        values['manifest-dir'],
        values['dry-run'],
      );
      line = `${values['dry-run'] ? 'WOULD STOP' : 'STOPPED'}: ${decision.reason}${done.length > 0 ? ` [${done.join('; ')}]` : ''}`;
    } catch (error) {
      line = `STOP INCOMPLETE: ${decision.reason} [${error instanceof Error ? error.message : 'failed'}]`;
      exitCode = 1;
    }
  }
  if (statePath && !values['dry-run'])
    await writeFile(statePath, JSON.stringify(decision.next) + '\n', { mode: 0o600 });
  (exitCode === 0 ? console.log : console.error)(`${prefix}${line}`);
  return exitCode;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (error: unknown) => {
      // Never echo responses: they could contain account identifiers.
      console.error(error instanceof Error ? error.message : 'R2 guard failed');
      process.exitCode = 1;
    },
  );
}
