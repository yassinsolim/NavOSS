import { createCipheriv, createDecipheriv, createHmac, randomBytes, randomUUID } from 'node:crypto';

import {
  communityAssertionClientData,
  type CommunityAssertedOperation,
  type CommunityAssertion,
  type CommunityChallengeResponse,
  type CommunityInstallationRegistrationRequest,
  type CommunityInstallationRegistrationResponse,
  type CommunityInstallationTrust,
  type CommunityReport,
  type CommunityReportPublication,
  type CommunityReportQuery,
  type CommunityReportResponse,
  type CommunityReportSubmissionRequest,
  type CommunityReportSubmissionResponse,
  type CommunityReportVoteRequest,
  type CommunityReportVoteResponse,
  type CommunityReportVoteValue,
  type Coordinate,
} from '@navoss/contracts';
import { Pool, type PoolClient } from 'pg';
import { z } from 'zod/v4';

import {
  AppAttestError,
  createAppAttestVerifier,
  sha256,
  type AppAttestVerifier,
} from './app-attest.js';
import {
  applyReporterOutcome,
  assessReport,
  cellLockKeys,
  coarsenForPublication,
  coarsenForTravelCheck,
  COMMUNITY_TRUST_RULES,
  decayEvidence,
  distanceMeters,
  expiryAfterVote,
  installationWeight,
  isImpossibleTravel,
  publicExpiresAt,
  publicReportedAt,
  rateLimitCell,
  reportLimitViolation,
  reportVisibility,
  voteLimitExceeded,
  type Evidence,
  type ReportEvidenceInput,
} from './community-trust.js';
import { pendingMigrations } from './migrations.js';

const CHALLENGE_LIFETIME_MS = 5 * 60 * 1_000;
const EXPIRED_REPORT_RETENTION_MS = 24 * 60 * 60 * 1_000;
const TRAVEL_POSITION_RETENTION_MS = 24 * 60 * 60 * 1_000;
const INACTIVE_INSTALLATION_RETENTION_MS = 90 * 24 * 60 * 60 * 1_000;
const PURGE_INTERVAL_MS = 15 * 60 * 1_000;
const MAXIMUM_NEARBY_CANDIDATES = 500;
const MAXIMUM_NEARBY_REPORTS = 200;

export type AttestationMode = 'enforce' | 'allow-development';

export type CommunityReportFailure =
  | 'already-registered'
  | 'attestation'
  | 'busy'
  | 'development-not-allowed'
  | 'duplicate-vote'
  | 'impossible-travel'
  | 'invalid-challenge'
  | 'not-found'
  | 'out-of-coverage'
  | 'rate-limited'
  | 'replay'
  | 'self-vote'
  | 'too-far'
  | 'unavailable'
  | 'unknown-installation';

export class CommunityReportError extends Error {
  public constructor(
    public readonly reason: CommunityReportFailure,
    options?: ErrorOptions,
  ) {
    super(`Community report request rejected: ${reason}`, options);
    this.name = 'CommunityReportError';
  }
}

export interface CommunityReportService {
  close(): Promise<void>;
  deleteInstallation(assertion: CommunityAssertion): Promise<void>;
  deleteReport(reportId: string, assertion: CommunityAssertion): Promise<void>;
  issueChallenge(): Promise<CommunityChallengeResponse>;
  nearby(query: CommunityReportQuery): Promise<CommunityReportResponse>;
  purgeExpired(): Promise<void>;
  readonly publication: CommunityReportPublication;
  register(
    request: CommunityInstallationRegistrationRequest,
  ): Promise<CommunityInstallationRegistrationResponse>;
  start(): void;
  submit(request: CommunityReportSubmissionRequest): Promise<CommunityReportSubmissionResponse>;
  vote(reportId: string, request: CommunityReportVoteRequest): Promise<CommunityReportVoteResponse>;
}

export interface CommunityReportServiceOptions {
  attestationMode: AttestationMode;
  clock?: () => Date;
  /** Secret for keyed key-id hashes and sealing stored public keys. At least 32 bytes. */
  installationSecret: Buffer;
  isInCoverage: (coordinate: Coordinate) => boolean;
  pool: Pool;
  publication: CommunityReportPublication;
  purgeIntervalMs?: number;
  /** Undefined when App Attest is not configured: reading works, writing is unavailable. */
  verifier: AppAttestVerifier | undefined;
}

interface InstallationRow {
  evidence_contradict: number;
  evidence_support: number;
  evidence_updated_at: Date;
  id: string;
  last_write_at: Date | null;
  last_write_latitude: number | null;
  last_write_longitude: number | null;
  sealed_public_key: Buffer;
  sign_count: string;
  trust: CommunityInstallationTrust;
}

interface AssertedInstallation {
  evidence: Evidence;
  id: string;
  lastWrite: { at: Date; position: Coordinate } | undefined;
  trust: CommunityInstallationTrust;
}

interface ReportRow {
  created_at: Date;
  expires_at: Date;
  id: string;
  installation_id: string;
  latitude: number;
  longitude: number;
  reporter_trust: CommunityInstallationTrust;
  reporter_weight: number;
  type: CommunityReport['type'];
  votes: {
    created_at: string;
    installation_id: string;
    vote: CommunityReportVoteValue;
    voter_trust: CommunityInstallationTrust;
    weight: number;
  }[];
}

/** Report columns with either the private or the published position. */
const reportColumns = (position: 'position' | 'public_position'): string => `
  r.id, r.installation_id, r.type, r.reporter_trust, r.reporter_weight, r.created_at, r.expires_at,
  ST_Y(r.${position}::geometry) AS latitude, ST_X(r.${position}::geometry) AS longitude,
  COALESCE(
    (SELECT json_agg(json_build_object(
       'installation_id', v.installation_id, 'vote', v.vote, 'voter_trust', v.voter_trust,
       'weight', v.weight, 'created_at', v.created_at))
     FROM community_report_votes v WHERE v.report_id = r.id),
    '[]'::json
  ) AS votes`;

const POINT_SQL = (longitude: string, latitude: string): string =>
  `ST_SetSRID(ST_MakePoint(${longitude}, ${latitude}), 4326)::geography`;

/** PostgreSQL deadlock and serialization failures: safe to retry the whole transaction. */
const RETRYABLE_SQLSTATES = new Set(['40001', '40P01']);
const MAXIMUM_TRANSACTION_ATTEMPTS = 3;

function base64ToBytes(value: string): Buffer {
  return Buffer.from(value, 'base64');
}

function toReportEvidence(row: ReportRow, now: Date): ReportEvidenceInput {
  return {
    createdAt: row.created_at,
    now,
    reporterTrust: row.reporter_trust,
    reporterWeight: row.reporter_weight,
    votes: row.votes.map((vote) => ({
      createdAt: new Date(vote.created_at),
      trust: vote.voter_trust,
      vote: vote.vote,
      weight: vote.weight,
    })),
  };
}

/**
 * Lock order, used by every write so concurrent writes cannot deadlock:
 *   1. cell advisory locks (submissions only), in `cellLockKeys` order;
 *   2. installation rows, ascending id, in one statement;
 *   3. report rows.
 * Vote evidence is always read in a fresh statement after the report row lock is held.
 */
export function createCommunityReportService(
  options: CommunityReportServiceOptions,
): CommunityReportService {
  if (options.installationSecret.length < 32) {
    throw new Error('The community installation secret must be at least 32 bytes.');
  }
  const clock = options.clock ?? (() => new Date());
  const pool = options.pool;
  let schemaReady = false;
  let purgeTimer: ReturnType<typeof setInterval> | undefined;

  const keyed = (purpose: string, keyId: Buffer): Buffer =>
    createHmac('sha256', options.installationSecret).update(purpose).update(keyId).digest();

  const seal = (keyId: Buffer, publicKey: Buffer): Buffer => {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', keyed('seal:', keyId), iv);
    const ciphertext = Buffer.concat([cipher.update(publicKey), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]);
  };

  const unseal = (keyId: Buffer, sealed: Buffer): Buffer => {
    const decipher = createDecipheriv('aes-256-gcm', keyed('seal:', keyId), sealed.subarray(0, 12));
    decipher.setAuthTag(sealed.subarray(12, 28));
    return Buffer.concat([decipher.update(sealed.subarray(28)), decipher.final()]);
  };

  const ensureSchema = async (): Promise<void> => {
    if (schemaReady) return;
    try {
      schemaReady = (await pendingMigrations(pool)).length === 0;
    } catch (error: unknown) {
      throw new CommunityReportError('unavailable', { cause: error });
    }
    if (!schemaReady) throw new CommunityReportError('unavailable');
  };

  const requireVerifier = (): AppAttestVerifier => {
    if (options.verifier === undefined) throw new CommunityReportError('unavailable');
    return options.verifier;
  };

  /** One-use: deleted outside any write transaction so a failed request still burns it. */
  const consumeChallenge = async (challenge: string, now: Date): Promise<void> => {
    const result = await pool.query(
      'DELETE FROM community_challenges WHERE challenge_hash = $1 AND expires_at > $2',
      [sha256(Buffer.from(challenge, 'utf8')), now],
    );
    if (result.rowCount !== 1) throw new CommunityReportError('invalid-challenge');
  };

  /**
   * Runs `work` in a transaction. Deadlocks and serialization failures are retried with the same,
   * already verified request (its counter update rolled back with the failed attempt), so a
   * conflict never silently burns the caller's challenge; if retries run out the caller gets a
   * retryable `busy` response.
   */
  const withTransaction = async <T>(work: (client: PoolClient) => Promise<T>): Promise<T> => {
    let client: PoolClient;
    try {
      client = await pool.connect();
    } catch (error: unknown) {
      throw new CommunityReportError('unavailable', { cause: error });
    }
    try {
      for (let attempt = 1; ; attempt += 1) {
        try {
          await client.query('BEGIN');
          const result = await work(client);
          await client.query('COMMIT');
          return result;
        } catch (error: unknown) {
          await client.query('ROLLBACK').catch(() => undefined);
          if (error instanceof CommunityReportError) throw error;
          const code = (error as { code?: unknown }).code;
          if (typeof code === 'string' && RETRYABLE_SQLSTATES.has(code)) {
            if (attempt < MAXIMUM_TRANSACTION_ATTEMPTS) continue;
            throw new CommunityReportError('busy', { cause: error });
          }
          throw new CommunityReportError('unavailable', { cause: error });
        }
      }
    } finally {
      client.release();
    }
  };

  /**
   * Locks the asserting installation together with `relatedInstallationIds` (ascending id), then
   * verifies the assertion and advances the counter. Untrusted installations are refused outright
   * when development attestation is not allowed, even if they were registered while it was.
   */
  const assertInstallation = async (
    client: PoolClient,
    assertion: CommunityAssertion,
    operation: CommunityAssertedOperation,
    now: Date,
    relatedInstallationIds: readonly string[] = [],
  ): Promise<AssertedInstallation> => {
    const verifier = requireVerifier();
    const keyId = base64ToBytes(assertion.keyId);
    const keyIdHash = keyed('id:', keyId);
    const found = await client.query<{ id: string }>(
      'SELECT id FROM community_installations WHERE key_id_hash = $1',
      [keyIdHash],
    );
    const installationId = found.rows[0]?.id;
    if (installationId === undefined) throw new CommunityReportError('unknown-installation');

    const locked = await client.query<InstallationRow>(
      `SELECT id, trust, sealed_public_key, sign_count::text AS sign_count,
              evidence_support, evidence_contradict, evidence_updated_at, last_write_at,
              ST_Y(last_write_position::geometry) AS last_write_latitude,
              ST_X(last_write_position::geometry) AS last_write_longitude
       FROM community_installations WHERE id = ANY($1::uuid[])
       ORDER BY id FOR UPDATE`,
      [[...new Set([installationId, ...relatedInstallationIds])]],
    );
    const row = locked.rows.find((candidate) => candidate.id === installationId);
    if (row === undefined) throw new CommunityReportError('unknown-installation');
    if (row.trust !== 'attested' && options.attestationMode !== 'allow-development') {
      throw new CommunityReportError('development-not-allowed');
    }

    let signCount: number;
    try {
      ({ signCount } = verifier.verifyAssertion({
        assertion: base64ToBytes(assertion.assertion),
        clientDataHash: sha256(
          Buffer.from(communityAssertionClientData(assertion.challenge, operation), 'utf8'),
        ),
        previousSignCount: Number(row.sign_count),
        publicKey: unseal(keyId, row.sealed_public_key),
      }));
    } catch (error: unknown) {
      if (error instanceof AppAttestError) {
        throw new CommunityReportError(error.reason === 'counter' ? 'replay' : 'attestation');
      }
      throw new CommunityReportError('attestation');
    }
    const advanced = await client.query(
      `UPDATE community_installations SET sign_count = $2, last_active_at = $3
       WHERE id = $1 AND sign_count < $2`,
      [row.id, signCount, now],
    );
    if (advanced.rowCount !== 1) throw new CommunityReportError('replay');

    return {
      evidence: decayEvidence(
        { contradict: row.evidence_contradict, support: row.evidence_support },
        now.getTime() - row.evidence_updated_at.getTime(),
        COMMUNITY_TRUST_RULES.installationEvidenceHalfLifeMs,
      ),
      id: row.id,
      lastWrite:
        row.last_write_at === null ||
        row.last_write_latitude === null ||
        row.last_write_longitude === null
          ? undefined
          : {
              at: row.last_write_at,
              position: { latitude: row.last_write_latitude, longitude: row.last_write_longitude },
            },
      trust: row.trust,
    };
  };

  /** Rejects impossible travel, then remembers only a ~1 km position for the next check. */
  const recordTravel = async (
    client: PoolClient,
    installation: AssertedInstallation,
    position: Coordinate,
    now: Date,
  ): Promise<void> => {
    if (
      installation.lastWrite !== undefined &&
      isImpossibleTravel({
        from: installation.lastWrite.position,
        fromAt: installation.lastWrite.at,
        to: position,
        toAt: now,
      })
    ) {
      throw new CommunityReportError('impossible-travel');
    }
    const coarse = coarsenForTravelCheck(position);
    await client.query(
      `UPDATE community_installations
       SET last_write_position = ${POINT_SQL('$2', '$3')}, last_write_at = $4
       WHERE id = $1`,
      [installation.id, coarse.longitude, coarse.latitude, now],
    );
  };

  /** Locks an active report row, then reads it and its votes in a fresh statement. */
  const lockActiveReport = async (
    client: PoolClient,
    reportId: string,
    now: Date,
  ): Promise<ReportRow | undefined> => {
    const locked = await client.query(
      'SELECT id FROM community_reports WHERE id = $1 AND expires_at > $2 FOR UPDATE',
      [reportId, now],
    );
    if (locked.rowCount !== 1) return undefined;
    const fresh = await client.query<ReportRow>(
      `SELECT ${reportColumns('position')} FROM community_reports r WHERE r.id = $1`,
      [reportId],
    );
    return fresh.rows[0];
  };

  /**
   * Records a vote on a report whose row (and both installations) the caller has locked. Untrusted
   * votes are stored for shadow analysis only: they never change expiry or anyone's credibility.
   */
  const applyVote = async (
    client: PoolClient,
    voter: AssertedInstallation,
    report: ReportRow,
    vote: CommunityReportVoteValue,
    now: Date,
  ): Promise<Date> => {
    if (report.installation_id === voter.id) throw new CommunityReportError('self-vote');
    const recent = await client.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM community_report_votes
       WHERE installation_id = $1 AND created_at > $2`,
      [voter.id, new Date(now.getTime() - 60 * 60 * 1_000)],
    );
    if (voteLimitExceeded(voter.trust, recent.rows[0]?.count ?? 0)) {
      throw new CommunityReportError('rate-limited');
    }
    const weight = installationWeight(voter.trust, voter.evidence);
    const inserted = await client.query(
      `INSERT INTO community_report_votes
         (report_id, installation_id, vote, voter_trust, weight, created_at)
       VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (report_id, installation_id) DO NOTHING`,
      [report.id, voter.id, vote, voter.trust, weight, now],
    );
    if (inserted.rowCount !== 1) throw new CommunityReportError('duplicate-vote');
    if (voter.trust !== 'attested') return report.expires_at;

    const assessment = assessReport(
      toReportEvidence(
        {
          ...report,
          votes: [
            ...report.votes,
            {
              created_at: now.toISOString(),
              installation_id: voter.id,
              vote,
              voter_trust: voter.trust,
              weight,
            },
          ],
        },
        now,
      ),
    );
    const expiresAt = expiryAfterVote({
      assessment,
      createdAt: report.created_at,
      expiresAt: report.expires_at,
      now,
      vote,
    });
    await client.query('UPDATE community_reports SET expires_at = $2 WHERE id = $1', [
      report.id,
      expiresAt,
    ]);

    // Independent outcome for the reporter's credibility; that row is already locked.
    const reporter = await client.query<{
      evidence_contradict: number;
      evidence_support: number;
      evidence_updated_at: Date;
    }>(
      `SELECT evidence_support, evidence_contradict, evidence_updated_at
       FROM community_installations WHERE id = $1`,
      [report.installation_id],
    );
    const reporterRow = reporter.rows[0];
    if (reporterRow !== undefined) {
      const updated = applyReporterOutcome(
        { contradict: reporterRow.evidence_contradict, support: reporterRow.evidence_support },
        now.getTime() - reporterRow.evidence_updated_at.getTime(),
        vote,
        weight,
      );
      await client.query(
        `UPDATE community_installations
         SET evidence_support = $2, evidence_contradict = $3, evidence_updated_at = $4
         WHERE id = $1`,
        [report.installation_id, updated.support, updated.contradict, now],
      );
    }
    return expiresAt;
  };

  const purgeExpired = async (): Promise<void> => {
    await ensureSchema();
    const now = clock().getTime();
    await pool.query('DELETE FROM community_challenges WHERE expires_at <= $1', [new Date(now)]);
    await pool.query('DELETE FROM community_reports WHERE expires_at < $1', [
      new Date(now - EXPIRED_REPORT_RETENTION_MS),
    ]);
    await pool.query(
      `UPDATE community_installations SET last_write_position = NULL, last_write_at = NULL
       WHERE last_write_at < $1`,
      [new Date(now - TRAVEL_POSITION_RETENTION_MS)],
    );
    await pool.query('DELETE FROM community_installations WHERE last_active_at < $1', [
      new Date(now - INACTIVE_INSTALLATION_RETENTION_MS),
    ]);
  };

  return {
    publication: options.publication,

    async close() {
      clearInterval(purgeTimer);
      await pool.end();
    },

    start() {
      if (purgeTimer !== undefined) return;
      void purgeExpired().catch(() => undefined);
      purgeTimer = setInterval(() => {
        void purgeExpired().catch(() => undefined);
      }, options.purgeIntervalMs ?? PURGE_INTERVAL_MS);
      purgeTimer.unref();
    },

    purgeExpired,

    async issueChallenge() {
      requireVerifier();
      await ensureSchema();
      const now = clock();
      const challenge = randomBytes(32).toString('base64url');
      const expiresAt = new Date(now.getTime() + CHALLENGE_LIFETIME_MS);
      try {
        await pool.query(
          'INSERT INTO community_challenges (challenge_hash, expires_at) VALUES ($1, $2)',
          [sha256(Buffer.from(challenge, 'utf8')), expiresAt],
        );
      } catch (error: unknown) {
        throw new CommunityReportError('unavailable', { cause: error });
      }
      return { challenge, expiresAt: expiresAt.toISOString() };
    },

    async register(request) {
      const verifier = requireVerifier();
      if (request.kind === 'development' && options.attestationMode !== 'allow-development') {
        throw new CommunityReportError('development-not-allowed');
      }
      await ensureSchema();
      const now = clock();
      await consumeChallenge(request.challenge, now);
      const keyId = base64ToBytes(request.keyId);

      let verified;
      try {
        verified =
          request.kind === 'app-attest'
            ? verifier.verifyAttestation({
                attestationObject: base64ToBytes(request.attestationObject),
                clientDataHash: sha256(Buffer.from(request.challenge, 'utf8')),
                keyId,
                now,
              })
            : verifier.verifyDevelopmentKey({
                keyId,
                publicKey: base64ToBytes(request.publicKey),
              });
      } catch {
        throw new CommunityReportError('attestation');
      }
      const trust: CommunityInstallationTrust =
        request.kind === 'app-attest' ? 'attested' : 'untrusted';
      let inserted;
      try {
        inserted = await pool.query(
          `INSERT INTO community_installations
             (id, key_id_hash, sealed_public_key, trust, sign_count, evidence_updated_at,
              registered_at, last_active_at)
           VALUES ($1, $2, $3, $4, $5, $6, $6, $6)
           ON CONFLICT (key_id_hash) DO NOTHING`,
          [
            randomUUID(),
            keyed('id:', keyId),
            seal(keyId, verified.publicKey),
            trust,
            verified.signCount,
            now,
          ],
        );
      } catch (error: unknown) {
        throw new CommunityReportError('unavailable', { cause: error });
      }
      if (inserted.rowCount !== 1) throw new CommunityReportError('already-registered');
      return { registeredAt: now.toISOString(), status: 'registered', trust };
    },

    async submit(request) {
      requireVerifier();
      if (!options.isInCoverage(request.coordinate)) {
        throw new CommunityReportError('out-of-coverage');
      }
      await ensureSchema();
      const now = clock();
      await consumeChallenge(request.assertion.challenge, now);
      const point = [request.coordinate.longitude, request.coordinate.latitude];
      return withTransaction(async (client) => {
        // 1. Serialize the cell count, merge search, and insert against nearby submissions.
        for (const [latitudeKey, longitudeKey] of cellLockKeys(request.coordinate)) {
          await client.query('SELECT pg_advisory_xact_lock($1::int, $2::int)', [
            latitudeKey,
            longitudeKey,
          ]);
        }

        // Cross-installation merging only where reports are published, and only between attested
        // installations: shadow mode must not reveal that someone else reported here.
        const self = await client.query<{ id: string; trust: CommunityInstallationTrust }>(
          'SELECT id, trust FROM community_installations WHERE key_id_hash = $1',
          [keyed('id:', base64ToBytes(request.assertion.keyId))],
        );
        const selfRow = self.rows[0];
        const mayMerge = options.publication !== 'shadow' && selfRow?.trust === 'attested';
        const candidate = mayMerge
          ? (
              await client.query<{ id: string; installation_id: string }>(
                `SELECT r.id, r.installation_id FROM community_reports r
                 WHERE r.type = $1 AND r.expires_at > $2 AND r.reporter_trust = 'attested'
                   AND r.installation_id <> $6
                   AND ST_DWithin(r.position, ${POINT_SQL('$3', '$4')}, $5)
                 ORDER BY ST_Distance(r.position, ${POINT_SQL('$3', '$4')}), r.id
                 LIMIT 1`,
                [request.type, now, ...point, COMMUNITY_TRUST_RULES.mergeRadiusMeters, selfRow.id],
              )
            ).rows[0]
          : undefined;

        // 2. Installation rows (self and the candidate's reporter), ascending id.
        const installation = await assertInstallation(
          client,
          request.assertion,
          {
            coordinate: request.coordinate,
            heading: request.heading,
            kind: 'submit-report',
            type: request.type,
          },
          now,
          candidate === undefined ? [] : [candidate.installation_id],
        );
        await recordTravel(client, installation, request.coordinate, now);

        const own = await client.query<{ expires_at: Date; id: string }>(
          `SELECT id, expires_at FROM community_reports
           WHERE installation_id = $1 AND type = $2 AND expires_at > $3
             AND ST_DWithin(position, ${POINT_SQL('$4', '$5')}, $6)
           LIMIT 1`,
          [installation.id, request.type, now, ...point, COMMUNITY_TRUST_RULES.mergeRadiusMeters],
        );
        const ownRow = own.rows[0];
        if (ownRow !== undefined) {
          return {
            expiresAt: ownRow.expires_at.toISOString(),
            reportId: ownRow.id,
            status: 'accepted' as const,
          };
        }

        // 3. The candidate report row, then its evidence in a fresh statement.
        if (candidate !== undefined) {
          const report = await lockActiveReport(client, candidate.id, now);
          if (report !== undefined) {
            const alreadyVoted = report.votes.some(
              (vote) => vote.installation_id === installation.id,
            );
            const expiresAt = alreadyVoted
              ? report.expires_at
              : await applyVote(client, installation, report, 'present', now);
            return {
              expiresAt: publicExpiresAt(expiresAt).toISOString(),
              reportId: report.id,
              status: 'merged' as const,
            };
          }
        }

        const cell = rateLimitCell(request.coordinate);
        const counts = await client.query<{
          cell: number;
          installation: number;
          same_type: number;
        }>(
          `SELECT
             count(*) FILTER (WHERE installation_id = $1)::int AS installation,
             count(*) FILTER (WHERE installation_id = $1 AND type = $2)::int AS same_type,
             count(*) FILTER (WHERE cell = $3 AND created_at > $5)::int AS cell
           FROM community_reports
           WHERE (installation_id = $1 OR cell = $3) AND created_at > $4`,
          [
            installation.id,
            request.type,
            cell,
            new Date(now.getTime() - 60 * 60 * 1_000),
            new Date(now.getTime() - 10 * 60 * 1_000),
          ],
        );
        const row = counts.rows[0];
        if (
          reportLimitViolation({
            cellReportsLastTenMinutes: row?.cell ?? 0,
            installationReportsLastHour: row?.installation ?? 0,
            sameTypeReportsLastHour: row?.same_type ?? 0,
            trust: installation.trust,
          }) !== undefined
        ) {
          throw new CommunityReportError('rate-limited');
        }

        const reportId = randomUUID();
        const expiresAt = new Date(now.getTime() + COMMUNITY_TRUST_RULES.reportLifetimeMs);
        const published = coarsenForPublication(request.coordinate);
        await client.query(
          `INSERT INTO community_reports
             (id, installation_id, type, position, public_position, heading, cell, reporter_trust,
              reporter_weight, created_at, expires_at)
           VALUES ($1, $2, $3, ${POINT_SQL('$4', '$5')}, ${POINT_SQL('$6', '$7')}, $8, $9, $10,
                   $11, $12, $13)`,
          [
            reportId,
            installation.id,
            request.type,
            ...point,
            published.longitude,
            published.latitude,
            request.heading ?? null,
            cell,
            installation.trust,
            installationWeight(installation.trust, installation.evidence),
            now,
            expiresAt,
          ],
        );
        return { expiresAt: expiresAt.toISOString(), reportId, status: 'accepted' as const };
      });
    },

    async vote(reportId, request) {
      requireVerifier();
      await ensureSchema();
      const now = clock();
      await consumeChallenge(request.assertion.challenge, now);
      return withTransaction(async (client) => {
        const owner = await client.query<{ installation_id: string }>(
          'SELECT installation_id FROM community_reports WHERE id = $1',
          [reportId],
        );
        const reporterId = owner.rows[0]?.installation_id;
        const voter = await assertInstallation(
          client,
          request.assertion,
          { kind: 'vote', observedAt: request.observedAt, reportId, vote: request.vote },
          now,
          reporterId === undefined ? [] : [reporterId],
        );
        const report =
          reporterId === undefined ? undefined : await lockActiveReport(client, reportId, now);
        if (report === undefined) throw new CommunityReportError('not-found');
        // The observation coordinate is used for these two checks only and never stored.
        if (
          distanceMeters(request.observedAt, report) > COMMUNITY_TRUST_RULES.voteProximityMeters
        ) {
          throw new CommunityReportError('too-far');
        }
        await recordTravel(client, voter, request.observedAt, now);
        const expiresAt = await applyVote(client, voter, report, request.vote, now);
        return { active: expiresAt > now, reportId, status: 'recorded' as const };
      });
    },

    async deleteReport(reportId, assertion) {
      requireVerifier();
      await ensureSchema();
      const now = clock();
      await consumeChallenge(assertion.challenge, now);
      await withTransaction(async (client) => {
        const installation = await assertInstallation(
          client,
          assertion,
          { kind: 'delete-report', reportId },
          now,
        );
        // Withdrawn immediately; the row is purged with other expired reports so a deletion cannot
        // be used to reset the reporter's own rate limits.
        const withdrawn = await client.query(
          `UPDATE community_reports SET expires_at = GREATEST(created_at, LEAST(expires_at, $3))
           WHERE id = $1 AND installation_id = $2 AND expires_at > $3`,
          [reportId, installation.id, now],
        );
        if (withdrawn.rowCount !== 1) throw new CommunityReportError('not-found');
      });
    },

    async deleteInstallation(assertion) {
      requireVerifier();
      await ensureSchema();
      const now = clock();
      await consumeChallenge(assertion.challenge, now);
      await withTransaction(async (client) => {
        const installation = await assertInstallation(
          client,
          assertion,
          { kind: 'delete-installation' },
          now,
        );
        await client.query('DELETE FROM community_installations WHERE id = $1', [installation.id]);
      });
    },

    async nearby(query) {
      const now = clock();
      if (options.publication === 'shadow') {
        return { generatedAt: now.toISOString(), publication: 'shadow', reports: [] };
      }
      await ensureSchema();
      let rows: ReportRow[];
      try {
        // Filters on the published (grid-snapped) position only, so narrowing the box cannot
        // locate a report more precisely than the coordinate it returns.
        const result = await pool.query<ReportRow>(
          `SELECT ${reportColumns('public_position')} FROM community_reports r
           WHERE r.expires_at > $1
             AND r.public_position && ST_MakeEnvelope($2, $3, $4, $5, 4326)::geography
           ORDER BY r.created_at DESC
           LIMIT ${String(MAXIMUM_NEARBY_CANDIDATES)}`,
          [now, query.west, query.south, query.east, query.north],
        );
        rows = result.rows;
      } catch (error: unknown) {
        throw new CommunityReportError('unavailable', { cause: error });
      }
      const reports: CommunityReport[] = [];
      for (const row of rows) {
        const visibility = reportVisibility(options.publication, toReportEvidence(row, now));
        if (!visibility.visible) continue;
        const base = {
          coordinate: { latitude: row.latitude, longitude: row.longitude },
          expiresAt: publicExpiresAt(row.expires_at).toISOString(),
          id: row.id,
          reportedAt: publicReportedAt(row.created_at).toISOString(),
          source: 'navoss-community' as const,
          type: row.type,
        };
        reports.push(
          visibility.state === 'confirmed'
            ? { ...base, confirmations: visibility.confirmations, state: 'confirmed' }
            : { ...base, confirmations: 0, state: 'unconfirmed' },
        );
        if (reports.length >= MAXIMUM_NEARBY_REPORTS) break;
      }
      // Random ids, not creation time, order the response.
      reports.sort((left, right) => left.id.localeCompare(right.id));
      return { generatedAt: now.toISOString(), publication: options.publication, reports };
    },
  };
}

const CommunityEnvironmentSchema = z
  .object({
    APP_ATTEST_BUNDLE_ID: z.string().min(1).default('org.navoss.mobile'),
    APP_ATTEST_ENVIRONMENT: z.enum(['production', 'development']).default('production'),
    APP_ATTEST_TEAM_ID: z
      .string()
      .regex(/^[A-Z0-9]{10}$/)
      .optional(),
    COMMUNITY_ATTESTATION_MODE: z.enum(['enforce', 'allow-development']).default('enforce'),
    COMMUNITY_INSTALLATION_SECRET: z.string().min(32).optional(),
    COMMUNITY_REPORTS_PUBLICATION: z.enum(['shadow', 'corroborated', 'attested']).default('shadow'),
    PGHOST: z.string().min(1).optional(),
  })
  .strict();

/**
 * Builds the service from the environment. Returns undefined when no database is configured.
 * Without a team id and installation secret the service still serves reads but refuses writes.
 */
export function createConfiguredCommunityReportService(input: {
  clock?: () => Date;
  isInCoverage: (coordinate: Coordinate) => boolean;
}): CommunityReportService | undefined {
  // Compose passes unset optional variables as empty strings; treat those as absent.
  const environment = CommunityEnvironmentSchema.parse(
    Object.fromEntries(
      Object.keys(CommunityEnvironmentSchema.shape).map((name) => [
        name,
        process.env[name] === '' ? undefined : process.env[name],
      ]),
    ),
  );
  if (environment.PGHOST === undefined) return undefined;
  const writable =
    environment.APP_ATTEST_TEAM_ID !== undefined &&
    environment.COMMUNITY_INSTALLATION_SECRET !== undefined;
  return createCommunityReportService({
    attestationMode: environment.COMMUNITY_ATTESTATION_MODE,
    ...(input.clock === undefined ? {} : { clock: input.clock }),
    installationSecret: Buffer.from(
      environment.COMMUNITY_INSTALLATION_SECRET ?? randomBytes(32).toString('hex'),
      'utf8',
    ),
    isInCoverage: input.isInCoverage,
    pool: new Pool({ max: 5 }),
    publication: environment.COMMUNITY_REPORTS_PUBLICATION,
    verifier:
      writable && environment.APP_ATTEST_TEAM_ID !== undefined
        ? createAppAttestVerifier({
            bundleId: environment.APP_ATTEST_BUNDLE_ID,
            environment: environment.APP_ATTEST_ENVIRONMENT,
            teamId: environment.APP_ATTEST_TEAM_ID,
          })
        : undefined,
  });
}
