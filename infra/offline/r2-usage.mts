// Read-only R2 usage check for the offline bundle bucket. It reads Cloudflare's GraphQL analytics
// (storage and the last 31 days of operations) and never lists, reads or writes objects, so running it
// costs no R2 operations. Exit status: 0 within limits, 1 above a limit, 2 when it cannot tell.
import { execFile } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { parseArgs, promisify } from 'node:util';

import {
  exceededLimits,
  FREE_TIER,
  isRecord,
  readUsage,
  type UsageLimits,
} from './r2-analytics.mts';

const run = promisify(execFile);

async function apiToken(): Promise<string> {
  if (process.env.CLOUDFLARE_API_TOKEN) return process.env.CLOUDFLARE_API_TOKEN;
  // The operator's existing `wrangler login`; the token is held in memory and never printed.
  const { stdout } = await run('npx', ['--yes', 'wrangler@4.162.0', 'auth', 'token', '--json'], {
    maxBuffer: 1 << 20,
  });
  const parsed: unknown = JSON.parse(stdout);
  const token = isRecord(parsed) ? parsed.token : undefined;
  if (typeof token !== 'string' || token === '') throw new Error('No Cloudflare credentials');
  return token;
}

function percent(value: number, of: number): string {
  return `${((100 * value) / of).toFixed(2)}% of the free tier`;
}

export async function main(args: string[]): Promise<number> {
  const { values } = parseArgs({
    args,
    options: {
      bucket: { type: 'string', default: 'navoss-offline' },
      // Defaults: 30% of free storage (three releases' worth of headroom) and 10% of free operations.
      'max-bytes': { type: 'string', default: String(3e9) },
      'max-objects': { type: 'string', default: '40' },
      'max-class-a': { type: 'string', default: String(100_000) },
      'max-class-b': { type: 'string', default: String(1_000_000) },
    },
  });
  const limits: UsageLimits = {
    bytes: Number(values['max-bytes']),
    objects: Number(values['max-objects']),
    classA: Number(values['max-class-a']),
    classB: Number(values['max-class-b']),
  };
  if (Object.values(limits).some((limit) => !Number.isFinite(limit) || limit < 0))
    throw new Error('Limits must be non-negative numbers');
  const usage = await readUsage(await apiToken(), process.env.CLOUDFLARE_ACCOUNT_ID, values.bucket);
  console.log(
    `Bucket ${values.bucket}: ${usage.bucketObjects} objects, ${usage.bucketBytes} bytes`,
  );
  console.log(
    `Account storage: ${usage.accountBytes} bytes (${percent(usage.accountBytes, FREE_TIER.bytes)})`,
  );
  console.log(
    `Last 31 days, whole account: Class A ${usage.classA} (${percent(usage.classA, FREE_TIER.classA)}), ` +
      `Class B ${usage.classB} (${percent(usage.classB, FREE_TIER.classB)}), free ${usage.free}`,
  );
  if (usage.unknownActions.length > 0)
    console.log(`Counted as Class A (not on the pricing page): ${usage.unknownActions.join(', ')}`);
  const exceeded = exceededLimits(usage, limits);
  if (exceeded.length > 0) {
    console.error(`Above limit: ${exceeded.join(', ')}`);
    return 1;
  }
  console.log('Within limits');
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (error: unknown) => {
      // Never echo responses: they could contain account identifiers.
      console.error(error instanceof Error ? error.message : 'R2 usage check failed');
      process.exitCode = 2;
    },
  );
}
