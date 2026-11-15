// Automatic stop for offline bundle hosting; see infra/offline/README.md ("Automatic stop").
//
// Each run lists the bucket (exact bytes and objects, one Class A operation that is also the
// run's heartbeat), reads the last 31 days of account operations from Cloudflare's analytics, and
// reads the custom domain's and the r2.dev URL's state. It stops hosting (withdraws the manifest,
// disables the custom domain, confirms r2.dev is off) when a stop condition is established, or
// after repeated runs that could not establish usage. It never re-enables anything.
//
// Runs with plain Node 24 (type stripping): node infra/offline/r2-guard.mts
// Exit status: 0 serving within limits, 1 stopped (now or earlier), 2 usage unknown this run (not
// yet stopped), 3 usage error.
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

import { cloudflare, isRecord, listBucket, readAnalytics } from './r2-analytics.mts';

export const DEFAULT_STOP = { classA: 200_000, classB: 2_000_000, bytes: 5e9 } as const;
export const DEFAULT_MAX_FAILURES = 4;
/** A heartbeat younger than this may not have reached the analytics yet (measured lag: 140 s). */
export const HEARTBEAT_SETTLE_MS = 4 * 60_000;
/**
 * A reference older than three timer periods is discarded: after an outage, analytics frozen at
 * that old point would still show it. The next run establishes a fresh heartbeat instead.
 */
export const HEARTBEAT_MAX_AGE_MS = 15 * 60_000;
const MANIFEST = 'manifest.json';
const STOPPED_MANIFEST = 'manifest.json.stopped';

export interface StopLimits {
  classA: number;
  classB: number;
  bytes: number;
}

export interface GuardState {
  /** Consecutive runs that could not establish usage. */
  failures: number;
  /** When and why this guard last stopped hosting. */
  stoppedAt?: string;
  reason?: string;
  /** When the previous run's bucket listing (the heartbeat) was made. */
  heartbeatAt?: string;
}

/** One run's view of Cloudflare; a field is missing when its request failed. */
export interface Observation {
  /** Last-31-day account operations; `current` says whether the analytics include a heartbeat. */
  operations?: { classA: number; classB: number; current: boolean };
  /** Stored bytes: the larger of this bucket's listing and the account's analytics samples. */
  bytes?: number;
  domainEnabled?: boolean;
  devUrlEnabled?: boolean;
  /** Why some part could not be read. */
  errors: string[];
}

export interface Decision {
  /** `stop` disables public access and withdraws the manifest; `none` changes nothing. */
  action: 'stop' | 'none';
  exitCode: 0 | 1 | 2;
  reason: string;
  next: GuardState;
}

/**
 * Stop conditions that are established are acted on even if other parts of the observation
 * failed; only then does an incomplete observation get its grace of `maxFailures` runs.
 */
export function decide(
  observation: Observation,
  state: GuardState,
  limits: StopLimits,
  maxFailures: number,
  now: Date,
): Decision {
  const { operations, bytes } = observation;
  const reasons: string[] = [];
  // Analytics only lag; a stale count above a threshold is still above it.
  if (operations && operations.classB > limits.classB)
    reasons.push(`Class B operations ${operations.classB} above ${limits.classB}`);
  if (operations && operations.classA > limits.classA)
    reasons.push(`Class A operations ${operations.classA} above ${limits.classA}`);
  if (bytes !== undefined && bytes > limits.bytes)
    reasons.push(`stored bytes ${bytes} above ${limits.bytes}`);
  if (observation.devUrlEnabled) reasons.push('the public r2.dev URL is enabled');
  if (reasons.length > 0) {
    const reason = reasons.join('; ');
    if (state.stoppedAt && observation.domainEnabled === false)
      return {
        action: 'stop', // idempotent: keeps the manifest withdrawn
        exitCode: 1,
        reason: `already stopped since ${state.stoppedAt}: ${reason}`,
        next: { ...state, failures: 0 },
      };
    return { action: 'stop', exitCode: 1, reason, next: stopped(state, 0, reason, now) };
  }
  const unknown = [...observation.errors];
  if (!operations) unknown.push('operations unknown');
  else if (!operations.current)
    unknown.push('analytics do not yet show the previous run’s heartbeat');
  if (bytes === undefined) unknown.push('storage unknown');
  if (observation.domainEnabled === undefined || observation.devUrlEnabled === undefined)
    unknown.push('domain state unknown');
  if (unknown.length > 0) {
    const failures = state.failures + 1;
    const why = [...new Set(unknown)].join('; ');
    if (failures < maxFailures)
      return {
        action: 'none',
        exitCode: 2,
        reason: `usage not established (${failures}/${maxFailures} before stopping): ${why}`,
        next: { ...state, failures },
      };
    const reason = `usage not established for ${failures} consecutive runs: ${why}`;
    return { action: 'stop', exitCode: 1, reason, next: stopped(state, failures, reason, now) };
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
  const { stoppedAt: _stoppedAt, reason: _reason, ...rest } = state;
  return {
    action: 'none',
    exitCode: 0,
    reason: `within limits (Class A ${operations!.classA}, Class B ${operations!.classB}, ${bytes} bytes)`,
    next: { ...rest, failures: 0 },
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
    ...(typeof value.heartbeatAt === 'string' ? { heartbeatAt: value.heartbeatAt } : {}),
  };
}

/** Reads KEY=value lines (the systemd/docker env-file format); values are not echoed. */
export function parseCredentials(text: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const match = /^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (match) values[match[1]!] = match[2]!.replace(/^(['"])(.*)\1$/, '$2');
  }
  return values;
}

/** Atomic replace: a crash leaves either the old or the new state, never a truncated file. */
async function writeState(path: string, state: GuardState): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, JSON.stringify(state) + '\n', { mode: 0o600 });
  await rename(temporary, path);
}

async function readOptional(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    if (isRecord(error) && error.code === 'ENOENT') return undefined;
    throw error;
  }
}

function domainPath(account: string, bucket: string, kind: string): string {
  return `/accounts/${account}/r2/buckets/${encodeURIComponent(bucket)}/domains/${kind}`;
}

function message(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

async function observe(
  token: string,
  account: string,
  bucket: string,
  domain: string,
  heartbeatAt: Date | undefined,
  now: Date,
): Promise<{ observation: Observation; heartbeatAt?: Date }> {
  const observation: Observation = { errors: [] };
  let listedBytes: number | undefined;
  let newHeartbeat: Date | undefined;
  try {
    const listingAt = new Date();
    listedBytes = (await listBucket(token, account, bucket)).bytes;
    newHeartbeat = listingAt;
  } catch (error) {
    observation.errors.push(message(error, 'listing failed'));
  }
  // Only a heartbeat old enough to have reached the analytics, and recent enough to say they are
  // still moving, can prove they are current.
  const age = heartbeatAt ? now.getTime() - heartbeatAt.getTime() : undefined;
  const usable = age !== undefined && age <= HEARTBEAT_MAX_AGE_MS ? heartbeatAt : undefined;
  const settled = usable && age! >= HEARTBEAT_SETTLE_MS ? usable : undefined;
  try {
    const analytics = await readAnalytics(token, account, {
      bucket,
      now,
      heartbeatAction: 'ListObjects',
      heartbeatSince: new Date((settled ?? now).getTime() - 60_000),
    });
    observation.operations = {
      classA: analytics.classA,
      classB: analytics.classB,
      // The heartbeat must also be inside the totals the decision is made on.
      current:
        settled !== undefined &&
        analytics.heartbeats > 0 &&
        analytics.heartbeatsInTotals >= analytics.heartbeats,
    };
    const sampled = [...analytics.storage.values()].reduce((sum, value) => sum + value.bytes, 0);
    if (listedBytes !== undefined) observation.bytes = Math.max(listedBytes, sampled);
  } catch (error) {
    observation.errors.push(message(error, 'analytics failed'));
    if (listedBytes !== undefined) observation.bytes = listedBytes;
  }
  try {
    const custom = await cloudflare(token, `${domainPath(account, bucket, 'custom')}/${domain}`);
    if (!isRecord(custom) || typeof custom.enabled !== 'boolean')
      throw new Error('Unexpected custom domain answer');
    observation.domainEnabled = custom.enabled;
  } catch (error) {
    observation.errors.push(message(error, 'custom domain state failed'));
  }
  try {
    const managed = await cloudflare(token, domainPath(account, bucket, 'managed'));
    if (!isRecord(managed) || typeof managed.enabled !== 'boolean')
      throw new Error('Unexpected r2.dev answer');
    observation.devUrlEnabled = managed.enabled;
  } catch (error) {
    observation.errors.push(message(error, 'r2.dev state failed'));
  }
  // A usable heartbeat that is not yet settled stays the reference until it is.
  const keep = usable && !settled ? usable : newHeartbeat;
  return { observation, ...(keep ? { heartbeatAt: keep } : {}) };
}

/** Disables public access and withdraws the manifest; every step is attempted independently. */
export async function stop(options: {
  token?: string;
  account?: string;
  bucket: string;
  domain: string;
  manifestDirectory?: string;
  dryRun: boolean;
}): Promise<string[]> {
  const { token, account, bucket, domain, manifestDirectory, dryRun } = options;
  const done: string[] = [];
  const failed: string[] = [];
  const step = async (what: string, action: () => Promise<string | void>) => {
    if (dryRun) {
      done.push(`would ${what}`);
      return;
    }
    try {
      done.push((await action()) ?? what);
    } catch (error) {
      failed.push(`${what}: ${message(error, 'failed')}`);
    }
  };
  if (manifestDirectory)
    // The API reads the manifest per request, so the next request answers the quiet 503.
    await step(`move ${MANIFEST} to ${STOPPED_MANIFEST}`, async () => {
      try {
        await rename(join(manifestDirectory, MANIFEST), join(manifestDirectory, STOPPED_MANIFEST));
      } catch (error) {
        if (isRecord(error) && error.code === 'ENOENT') return `${MANIFEST} already withdrawn`;
        throw error;
      }
    });
  if (token && account) {
    const set = (kind: string, path: string, label: string) =>
      step(`disable ${label}`, async () => {
        await cloudflare(token, path, { enabled: false }, 'PUT');
        const after = await cloudflare(token, path);
        if (!isRecord(after) || after.enabled !== false)
          throw new Error(`${kind} still enabled after the request`);
      });
    await set('custom domain', `${domainPath(account, bucket, 'custom')}/${domain}`, domain);
    await set('r2.dev URL', domainPath(account, bucket, 'managed'), 'r2.dev');
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
      credentials: { type: 'string' },
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
  const dryRun = values['dry-run'];
  const now = new Date();
  let credentials: Record<string, string> = {};
  const problems: string[] = [];
  if (values.credentials) {
    try {
      credentials = parseCredentials(await readFile(values.credentials, 'utf8'));
    } catch (error) {
      problems.push(`credentials unreadable: ${message(error, 'failed')}`);
    }
  }
  const token = credentials.CLOUDFLARE_API_TOKEN ?? process.env.CLOUDFLARE_API_TOKEN;
  const account = credentials.CLOUDFLARE_ACCOUNT_ID ?? process.env.CLOUDFLARE_ACCOUNT_ID;

  // An unreadable state file cannot count failures, so it is itself a reason to stop.
  let state: GuardState = { failures: 0 };
  let stateProblem: string | undefined;
  if (values.state) {
    try {
      state = parseState(await readOptional(values.state));
    } catch (error) {
      stateProblem = `state file unreadable (${message(error, 'failed')})`;
    }
  }
  let decision: Decision;
  let heartbeatAt: Date | undefined;
  let observed = false;
  if (stateProblem) {
    decision = {
      action: 'stop',
      exitCode: 1,
      reason: stateProblem,
      next: stopped({ failures: 0 }, 0, stateProblem, now),
    };
  } else {
    let observation: Observation = { errors: [...problems] };
    if (token && account) {
      const previous = state.heartbeatAt ? new Date(state.heartbeatAt) : undefined;
      const result = await observe(token, account, values.bucket, values.domain, previous, now);
      observation = { ...result.observation, errors: [...problems, ...result.observation.errors] };
      heartbeatAt = result.heartbeatAt;
      observed = true;
    } else {
      observation.errors.push('CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID are required');
    }
    decision = decide(observation, state, limits, maxFailures, now);
  }
  // The heartbeat reference is exactly what this run established (none if its listing failed).
  const { heartbeatAt: _previousHeartbeat, ...decided } = decision.next;
  const next: GuardState = observed
    ? { ...decided, ...(heartbeatAt ? { heartbeatAt: heartbeatAt.toISOString() } : {}) }
    : decision.next;
  // Record the run before acting; if the record cannot be kept, failures could never add up.
  if (values.state && !dryRun) {
    try {
      await writeState(values.state, next);
    } catch (error) {
      const reason = `state file not writable (${message(error, 'failed')}): ${decision.reason}`;
      decision = { ...decision, action: 'stop', exitCode: 1, reason };
    }
  }
  const prefix = dryRun ? 'dry run: ' : '';
  let exitCode: number = decision.exitCode;
  let line = decision.reason;
  if (decision.action === 'stop') {
    try {
      const done = await stop({
        token,
        account,
        bucket: values.bucket,
        domain: values.domain,
        manifestDirectory: values['manifest-dir'],
        dryRun,
      });
      line = `${dryRun ? 'WOULD STOP' : 'STOPPED'}: ${decision.reason} [${done.join('; ')}]`;
    } catch (error) {
      line = `STOP INCOMPLETE: ${decision.reason} [${message(error, 'failed')}]`;
      exitCode = 1;
    }
  }
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
      console.error(message(error, 'R2 guard failed'));
      process.exitCode = 1;
    },
  );
}
