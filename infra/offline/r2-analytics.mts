// Cloudflare R2 usage from the GraphQL Analytics API, shared by r2-usage.mts (report) and
// r2-guard.mts (automatic stop). Reading analytics performs no R2 operation. Only erasable
// TypeScript is used so Node runs this file directly (type stripping) on the VM.
const API = 'https://api.cloudflare.com/client/v4';

// https://developers.cloudflare.com/r2/pricing/ (checked 2026-11-15). Anything unlisted is counted
// as Class A, the expensive class, so a new operation name can only make the check stricter.
const CLASS_B = new Set([
  'HeadBucket',
  'HeadObject',
  'GetObject',
  'UsageSummary',
  'GetBucketEncryption',
  'GetBucketLocation',
  'GetBucketCors',
  'GetBucketLifecycleConfiguration',
]);
const FREE = new Set(['DeleteObject', 'DeleteBucket', 'AbortMultipartUpload']);
const CLASS_A_KNOWN = new Set([
  'ListBuckets',
  'PutBucket',
  'ListObjects',
  'PutObject',
  'CopyObject',
  'CompleteMultipartUpload',
  'CreateMultipartUpload',
  'LifecycleStorageTierTransition',
  'ListMultipartUploads',
  'UploadPart',
  'UploadPartCopy',
  'ListParts',
  'PutBucketEncryption',
  'PutBucketCors',
  'PutBucketLifecycleConfiguration',
]);

export const FREE_TIER = { bytes: 10e9, classA: 1_000_000, classB: 10_000_000 } as const;

export interface UsageLimits {
  bytes: number;
  objects: number;
  classA: number;
  classB: number;
}

export interface Usage {
  bucketBytes: number;
  bucketObjects: number;
  accountBytes: number;
  classA: number;
  classB: number;
  free: number;
  unknownActions: string[];
}

export function classifyOperations(groups: { action: string; requests: number }[]) {
  const totals = { classA: 0, classB: 0, free: 0, unknownActions: [] as string[] };
  for (const { action, requests } of groups) {
    if (CLASS_B.has(action)) totals.classB += requests;
    else if (FREE.has(action)) totals.free += requests;
    else {
      totals.classA += requests;
      if (!CLASS_A_KNOWN.has(action)) totals.unknownActions.push(action);
    }
  }
  return totals;
}

/** Names every limit the usage exceeds; empty when all are within limits. */
export function exceededLimits(usage: Usage, limits: UsageLimits): string[] {
  const exceeded: string[] = [];
  if (usage.bucketBytes > limits.bytes) exceeded.push('bucket bytes');
  if (usage.accountBytes > limits.bytes) exceeded.push('account bytes');
  if (usage.bucketObjects > limits.objects) exceeded.push('bucket objects');
  if (usage.classA > limits.classA) exceeded.push('Class A operations');
  if (usage.classB > limits.classB) exceeded.push('Class B operations');
  return exceeded;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function records(value: unknown, what: string): Record<string, unknown>[] {
  if (!Array.isArray(value) || !value.every(isRecord)) throw new Error(`Unexpected ${what}`);
  return value;
}

function count(value: unknown, what: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0)
    throw new Error(`Unexpected ${what}`);
  return value;
}

function text(value: unknown, what: string): string {
  if (typeof value !== 'string') throw new Error(`Unexpected ${what}`);
  return value;
}

/**
 * Returns the REST `result` or GraphQL `data` member. Errors name the path with account and zone
 * identifiers shortened, and never echo the response.
 */
export async function cloudflare(
  token: string,
  path: string,
  body?: unknown,
  method: 'GET' | 'POST' | 'PUT' = body === undefined ? 'GET' : 'POST',
): Promise<unknown> {
  const shown = path.replace(/[0-9a-f]{32}/g, (id) => `${id.slice(0, 4)}…`);
  const response = await fetch(`${API}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  const json: unknown = await response.json().catch(() => undefined);
  const errors = isRecord(json) && Array.isArray(json.errors) && json.errors.length > 0;
  if (!response.ok || !isRecord(json) || errors)
    throw new Error(`Cloudflare API ${response.status} for ${method} ${shown}`);
  return json.result ?? json.data;
}

const QUERY = `query ($account: String!, $monthStart: Time!, $dayAgo: Time!, $now: Time!) {
  viewer { accounts(filter: { accountTag: $account }) {
    operations: r2OperationsAdaptiveGroups(limit: 1000,
      filter: { datetime_geq: $monthStart, datetime_leq: $now }) {
      sum { requests } dimensions { actionType }
    }
    storage: r2StorageAdaptiveGroups(limit: 1000,
      filter: { datetime_geq: $dayAgo, datetime_leq: $now }, orderBy: [datetime_DESC]) {
      max { objectCount payloadSize metadataSize } dimensions { bucketName datetime }
    }
  } }
}`;

export async function readUsage(
  token: string,
  configuredAccount: string | undefined,
  bucket: string,
  now = new Date(),
): Promise<Usage> {
  let account = configuredAccount;
  if (!account) {
    const accounts = records(await cloudflare(token, '/accounts'), 'account list');
    if (accounts.length !== 1) throw new Error('Set CLOUDFLARE_ACCOUNT_ID: several accounts');
    account = text(accounts[0]!.id, 'account id');
  }
  // R2 bills per calendar month (UTC); the storage dataset is sampled, so read the last day.
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const dayAgo = new Date(now.getTime() - 86_400_000);
  const data = await cloudflare(token, '/graphql', {
    query: QUERY,
    variables: {
      account,
      monthStart: monthStart.toISOString(),
      dayAgo: dayAgo.toISOString(),
      now: now.toISOString(),
    },
  });
  const viewer = isRecord(data) && isRecord(data.viewer) ? data.viewer : undefined;
  const result = records(viewer?.accounts, 'analytics response')[0];
  if (!result) throw new Error('Account analytics unavailable');
  const latest = new Map<string, { objects: number; bytes: number }>();
  for (const row of records(result.storage, 'storage analytics')) {
    const max = isRecord(row.max) ? row.max : {};
    const dimensions = isRecord(row.dimensions) ? row.dimensions : {};
    const name = text(dimensions.bucketName, 'bucket name');
    // Rows are newest first; keep each bucket's latest sample.
    if (latest.has(name)) continue;
    latest.set(name, {
      objects: count(max.objectCount, 'object count'),
      bytes: count(max.payloadSize, 'payload size') + count(max.metadataSize, 'metadata size'),
    });
  }
  const own = latest.get(bucket);
  // Never report a missing sample as an empty bucket (new buckets appear after a delay).
  if (!own) throw new Error(`No storage sample for ${bucket} in the last 24 hours`);
  const operations = classifyOperations(
    records(result.operations, 'operation analytics').map((row) => ({
      action: text(isRecord(row.dimensions) ? row.dimensions.actionType : undefined, 'action'),
      requests: count(isRecord(row.sum) ? row.sum.requests : undefined, 'request count'),
    })),
  );
  return {
    bucketBytes: own.bytes,
    bucketObjects: own.objects,
    accountBytes: [...latest.values()].reduce((sum, value) => sum + value.bytes, 0),
    ...operations,
  };
}
