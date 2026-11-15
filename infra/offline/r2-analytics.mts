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

/** Operations are summed over a rolling window: Cloudflare bills per billing cycle, which is not
 * readable with these permissions, and 31 days covers any cycle (the dataset allows 32). */
export const OPERATIONS_WINDOW_DAYS = 31;
const DAY_MS = 86_400_000;

const QUERY = `query ($account: String!, $since: Time!, $storageSince: Time!, $now: Time!,
  $heartbeatSince: Time!, $bucket: String!, $heartbeatAction: String!) {
  viewer { accounts(filter: { accountTag: $account }) {
    operations: r2OperationsAdaptiveGroups(limit: 1000,
      filter: { datetime_geq: $since, datetime_leq: $now }) {
      sum { requests } dimensions { actionType }
    }
    heartbeat: r2OperationsAdaptiveGroups(limit: 10, filter: { datetime_geq: $heartbeatSince,
      datetime_leq: $now, bucketName: $bucket, actionType: $heartbeatAction }) {
      sum { requests }
    }
    storage: r2StorageAdaptiveGroups(limit: 1000,
      filter: { datetime_geq: $storageSince, datetime_leq: $now }, orderBy: [datetime_DESC]) {
      max { objectCount payloadSize metadataSize } dimensions { bucketName datetime }
    }
  } }
}`;

export interface Analytics {
  classA: number;
  classB: number;
  free: number;
  unknownActions: string[];
  /** Latest storage sample per bucket from the last 48 hours; a new bucket may have none. */
  storage: Map<string, { objects: number; bytes: number }>;
  /** Requests of the heartbeat action on the bucket since `heartbeatSince`. */
  heartbeats: number;
  /** Requests of the heartbeat action inside the 31-day totals above. */
  heartbeatsInTotals: number;
}

export async function resolveAccount(token: string, configured: string | undefined) {
  if (configured) return configured;
  const accounts = records(await cloudflare(token, '/accounts'), 'account list');
  if (accounts.length !== 1) throw new Error('Set CLOUDFLARE_ACCOUNT_ID: several accounts');
  return text(accounts[0]!.id, 'account id');
}

/** Account-wide operations over the last 31 days, storage samples, and a heartbeat count. */
export async function readAnalytics(
  token: string,
  account: string,
  options: { bucket: string; now: Date; heartbeatAction?: string; heartbeatSince?: Date },
): Promise<Analytics> {
  const { bucket, now } = options;
  const data = await cloudflare(token, '/graphql', {
    query: QUERY,
    variables: {
      account,
      since: new Date(now.getTime() - OPERATIONS_WINDOW_DAYS * DAY_MS).toISOString(),
      storageSince: new Date(now.getTime() - 2 * DAY_MS).toISOString(),
      now: now.toISOString(),
      bucket,
      heartbeatAction: options.heartbeatAction ?? 'ListObjects',
      heartbeatSince: (options.heartbeatSince ?? now).toISOString(),
    },
  });
  const viewer = isRecord(data) && isRecord(data.viewer) ? data.viewer : undefined;
  const result = records(viewer?.accounts, 'analytics response')[0];
  if (!result) throw new Error('Account analytics unavailable');
  const storage = new Map<string, { objects: number; bytes: number }>();
  for (const row of records(result.storage, 'storage analytics')) {
    const max = isRecord(row.max) ? row.max : {};
    const dimensions = isRecord(row.dimensions) ? row.dimensions : {};
    const name = text(dimensions.bucketName, 'bucket name');
    // Rows are newest first; keep each bucket's latest sample.
    if (storage.has(name)) continue;
    storage.set(name, {
      objects: count(max.objectCount, 'object count'),
      bytes: count(max.payloadSize, 'payload size') + count(max.metadataSize, 'metadata size'),
    });
  }
  const sumRequests = (rows: unknown, what: string) =>
    records(rows, what).map((row) => ({
      action: text(isRecord(row.dimensions) ? row.dimensions.actionType : undefined, 'action'),
      requests: count(isRecord(row.sum) ? row.sum.requests : undefined, 'request count'),
    }));
  const heartbeats = records(result.heartbeat, 'heartbeat analytics').reduce(
    (sum, row) => sum + count(isRecord(row.sum) ? row.sum.requests : undefined, 'request count'),
    0,
  );
  const totals = sumRequests(result.operations, 'operation analytics');
  const heartbeatAction = options.heartbeatAction ?? 'ListObjects';
  return {
    ...classifyOperations(totals),
    storage,
    heartbeats,
    heartbeatsInTotals: totals
      .filter(({ action }) => action === heartbeatAction)
      .reduce((sum, { requests }) => sum + requests, 0),
  };
}

/** Exact object count and bytes of a bucket from the R2 REST listing (one Class A per page). */
export async function listBucket(
  token: string,
  account: string,
  bucket: string,
): Promise<{ objects: number; bytes: number }> {
  let objects = 0;
  let bytes = 0;
  let cursor: string | undefined;
  for (let page = 0; page < 100; page += 1) {
    const query = new URLSearchParams({ per_page: '1000', ...(cursor ? { cursor } : {}) });
    const path = `/accounts/${account}/r2/buckets/${encodeURIComponent(bucket)}/objects?${query}`;
    const response = await cloudflareWithInfo(token, path);
    for (const item of records(response.result, 'object listing')) {
      objects += 1;
      bytes += count(item.size, 'object size');
    }
    const info = isRecord(response.resultInfo) ? response.resultInfo : {};
    const usable = typeof info.cursor === 'string' && info.cursor !== '' ? info.cursor : undefined;
    // A truncated page without a cursor would make a partial total look complete.
    if (info.is_truncated === true && !usable)
      throw new Error('R2 returned a truncated listing without a cursor');
    cursor = info.is_truncated === false ? undefined : usable;
    if (!cursor) return { objects, bytes };
  }
  throw new Error('Object listing did not end within 100 pages');
}

/** Like `cloudflare`, but also returns `result_info` (listing cursors). */
async function cloudflareWithInfo(token: string, path: string) {
  const shown = path.replace(/[0-9a-f]{32}/g, (id) => `${id.slice(0, 4)}…`);
  const response = await fetch(`${API}${path}`, {
    headers: { authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(30_000),
  });
  const json: unknown = await response.json().catch(() => undefined);
  if (!response.ok || !isRecord(json) || (Array.isArray(json.errors) && json.errors.length > 0))
    throw new Error(`Cloudflare API ${response.status} for GET ${shown}`);
  return { result: json.result, resultInfo: json.result_info };
}

/** Report view for r2-usage.mts: analytics only, so it performs no R2 operation. */
export async function readUsage(
  token: string,
  configuredAccount: string | undefined,
  bucket: string,
  now = new Date(),
): Promise<Usage> {
  const account = await resolveAccount(token, configuredAccount);
  const analytics = await readAnalytics(token, account, { bucket, now });
  const own = analytics.storage.get(bucket);
  // Never report a missing sample as an empty bucket (new buckets appear after a delay).
  if (!own) throw new Error(`No storage sample for ${bucket} in the last 48 hours`);
  return {
    bucketBytes: own.bytes,
    bucketObjects: own.objects,
    accountBytes: [...analytics.storage.values()].reduce((sum, value) => sum + value.bytes, 0),
    classA: analytics.classA,
    classB: analytics.classB,
    free: analytics.free,
    unknownActions: analytics.unknownActions,
  };
}
