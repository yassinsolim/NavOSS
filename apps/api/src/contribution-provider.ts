import { randomUUID } from 'node:crypto';

import {
  ContributionSubmissionResponseSchema,
  type ContributionSubmissionRequest,
  type ContributionSubmissionResponse,
} from '@navoss/contracts';
import { Pool, type PoolClient } from 'pg';

const MAX_PENDING_SUBMISSIONS = 10_000;
const RETENTION_DAYS = 90;
const RETENTION_SWEEP_INTERVAL_MS = 60 * 60 * 1_000;

export class ContributionProviderError extends Error {
  public constructor(
    message: string,
    public readonly reason: 'full' | 'unavailable',
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'ContributionProviderError';
  }
}

export interface ContributionProvider {
  close?(): Promise<void>;
  start?(): void;
  submit(request: ContributionSubmissionRequest): Promise<ContributionSubmissionResponse>;
}

interface ContributionProviderOptions {
  clock?: () => Date;
  maximumPendingSubmissions?: number;
  retentionSweepIntervalMs?: number;
}

function response(submissionId: string, acceptedAt: Date): ContributionSubmissionResponse {
  return ContributionSubmissionResponseSchema.parse({
    acceptedAt: acceptedAt.toISOString(),
    status: 'accepted',
    submissionId,
  });
}

export function createInMemoryContributionProvider(
  options: ContributionProviderOptions = {},
): ContributionProvider {
  const clock = options.clock ?? (() => new Date());
  const maximumPendingSubmissions = options.maximumPendingSubmissions ?? MAX_PENDING_SUBMISSIONS;
  const submissions = new Map<string, ContributionSubmissionResponse>();

  return {
    submit(request) {
      const existing = submissions.get(request.draftId);
      if (existing !== undefined) return Promise.resolve(existing);
      if (submissions.size >= maximumPendingSubmissions) {
        return Promise.reject(new ContributionProviderError('Submission queue is full.', 'full'));
      }
      const accepted = response(randomUUID(), clock());
      submissions.set(request.draftId, accepted);
      return Promise.resolve(accepted);
    },
  };
}

async function initialize(client: PoolClient): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS contribution_submissions (
      id uuid PRIMARY KEY,
      draft_id text NOT NULL UNIQUE CHECK (length(draft_id) BETWEEN 1 AND 100),
      type text NOT NULL CHECK (type IN ('missing-place', 'place-correction', 'route-issue', 'road-change')),
      description text NOT NULL CHECK (length(description) BETWEEN 3 AND 800),
      location_label text CHECK (location_label IS NULL OR length(location_label) BETWEEN 1 AND 160),
      client_created_at timestamptz NOT NULL,
      received_at timestamptz NOT NULL,
      status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'reviewed', 'resolved', 'rejected'))
    )
  `);
  await client.query(
    'CREATE INDEX IF NOT EXISTS contribution_submissions_received_at_idx ON contribution_submissions (received_at)',
  );
}

export function createPostgresContributionProvider(
  options: ContributionProviderOptions = {},
): ContributionProvider {
  const clock = options.clock ?? (() => new Date());
  const maximumPendingSubmissions = options.maximumPendingSubmissions ?? MAX_PENDING_SUBMISSIONS;
  const retentionSweepIntervalMs = options.retentionSweepIntervalMs ?? RETENTION_SWEEP_INTERVAL_MS;
  const pool = new Pool();
  let retentionSweep: ReturnType<typeof setInterval> | undefined;
  let sweeping = false;

  const removeExpired = async (): Promise<void> => {
    if (sweeping) return;
    sweeping = true;
    let client: PoolClient | undefined;
    try {
      client = await pool.connect();
      await initialize(client);
      await client.query(
        `DELETE FROM contribution_submissions
         WHERE received_at < now() - ($1::text || ' days')::interval`,
        [String(RETENTION_DAYS)],
      );
    } finally {
      sweeping = false;
      client?.release();
    }
  };

  return {
    close: async () => {
      if (retentionSweep !== undefined) clearInterval(retentionSweep);
      await pool.end();
    },
    start: () => {
      if (retentionSweep !== undefined) return;
      void removeExpired().catch(() => undefined);
      retentionSweep = setInterval(() => {
        void removeExpired().catch(() => undefined);
      }, retentionSweepIntervalMs);
      retentionSweep.unref();
    },
    async submit(request) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await initialize(client);
        await client.query('LOCK TABLE contribution_submissions IN SHARE ROW EXCLUSIVE MODE');
        await client.query(
          `DELETE FROM contribution_submissions
           WHERE received_at < now() - ($1::text || ' days')::interval`,
          [String(RETENTION_DAYS)],
        );

        const existing = await client.query<{ id: string; received_at: Date }>(
          'SELECT id, received_at FROM contribution_submissions WHERE draft_id = $1',
          [request.draftId],
        );
        const existingRow = existing.rows[0];
        if (existingRow !== undefined) {
          await client.query('COMMIT');
          return response(existingRow.id, existingRow.received_at);
        }

        const pending = await client.query<{ count: string }>(
          "SELECT count(*)::text AS count FROM contribution_submissions WHERE status = 'pending'",
        );
        if (
          Number(pending.rows[0]?.count ?? maximumPendingSubmissions) >= maximumPendingSubmissions
        ) {
          throw new ContributionProviderError('Submission queue is full.', 'full');
        }

        const acceptedAt = clock();
        const submissionId = randomUUID();
        await client.query(
          `INSERT INTO contribution_submissions
            (id, draft_id, type, description, location_label, client_created_at, received_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [
            submissionId,
            request.draftId,
            request.type,
            request.description,
            request.locationLabel ?? null,
            request.createdAt,
            acceptedAt,
          ],
        );
        await client.query('COMMIT');
        return response(submissionId, acceptedAt);
      } catch (error: unknown) {
        await client.query('ROLLBACK').catch(() => undefined);
        if (error instanceof ContributionProviderError) throw error;
        throw new ContributionProviderError('Contribution could not be stored.', 'unavailable', {
          cause: error,
        });
      } finally {
        client.release();
      }
    },
  };
}

export function createConfiguredContributionProvider(
  options: ContributionProviderOptions = {},
): ContributionProvider {
  return process.env.PGHOST === undefined
    ? createInMemoryContributionProvider(options)
    : createPostgresContributionProvider(options);
}
