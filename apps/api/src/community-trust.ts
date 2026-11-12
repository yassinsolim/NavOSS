import type {
  CommunityInstallationTrust,
  CommunityReportPublication,
  CommunityReportVoteValue,
} from '@navoss/contracts';

/**
 * Pure trust, credibility, limit, and expiry rules for community road reports
 * (docs/architecture/community-reports.md). Nothing here touches the database or the clock.
 */

const MINUTE_MS = 60 * 1_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

export const COMMUNITY_TRUST_RULES = {
  /** Default lifetime of a new report. */
  reportLifetimeMs: 2 * HOUR_MS,
  /** Hard cap on lifetime, however often a report is reconfirmed. */
  maximumReportLifetimeMs: 12 * HOUR_MS,
  /** Report evidence half-life: unconfirmed evidence fades quickly. */
  reportEvidenceHalfLifeMs: 90 * MINUTE_MS,
  /** Installation credibility half-life: old outcomes stop counting. */
  installationEvidenceHalfLifeMs: 30 * DAY_MS,
  /** Contradicted outcomes weigh more than supported ones. */
  contradictionPenalty: 2,
  /** Beta prior for a new installation (mean 0.5: low influence). */
  installationPrior: { alpha: 2, beta: 2 },
  /** Beta prior for a single report's presence. */
  reportPrior: { alpha: 1, beta: 1 },
  /** Untrusted (development) installations get a quarter of the weight. */
  trustFactor: { attested: 1, untrusted: 0.25 } satisfies Record<
    CommunityInstallationTrust,
    number
  >,
  /** One-sided z for the lower confidence bound (about 84%). */
  lowerBoundZ: 1,
  /** Corroboration: the lower bound must reach this... */
  minimumLowerBound: 0.4,
  /** ...and at least this many distinct installations must support the report. */
  minimumIndependentDevices: 2,
  /** Attested publication shows a single report only from a reporter at least this credible. */
  minimumSingleReporterWeight: 0.3,
  /** Same-type reports from different installations within this radius merge. */
  mergeRadiusMeters: 150,
  /** A voter must be this close to the report when voting. */
  voteProximityMeters: 1_500,
  /** Impossible travel: faster than this between two writes is rejected. */
  maximumTravelSpeedMetersPerSecond: 70,
  /** Slack for the coarsened last-write position (rounded to 0.01 degree). */
  travelSlackMeters: 2_000,
} as const;

export const COMMUNITY_WRITE_LIMITS = {
  attested: { reportsPerHour: 10, reportsPerTypePerHour: 3, votesPerHour: 30 },
  untrusted: { reportsPerHour: 2, reportsPerTypePerHour: 1, votesPerHour: 5 },
  /** Coordinated-burst guard: total new reports in one cell in ten minutes. */
  cellReportsPerTenMinutes: 12,
} as const;

export interface Evidence {
  contradict: number;
  support: number;
}

export interface LatLng {
  latitude: number;
  longitude: number;
}

/** Exponential decay of accumulated evidence over `elapsedMs`. */
export function decayEvidence(evidence: Evidence, elapsedMs: number, halfLifeMs: number): Evidence {
  const factor = elapsedMs <= 0 ? 1 : 0.5 ** (elapsedMs / halfLifeMs);
  return { contradict: evidence.contradict * factor, support: evidence.support * factor };
}

export function betaMean(alpha: number, beta: number): number {
  return alpha / (alpha + beta);
}

/** Normal approximation of a Beta lower confidence bound, clamped to [0, 1]. */
export function betaLowerBound(alpha: number, beta: number, z: number): number {
  const total = alpha + beta;
  const variance = (alpha * beta) / (total * total * (total + 1));
  return Math.min(1, Math.max(0, betaMean(alpha, beta) - z * Math.sqrt(variance)));
}

/** Internal credibility mean of an installation from its decayed outcome evidence. */
export function installationCredibility(evidence: Evidence): number {
  const prior = COMMUNITY_TRUST_RULES.installationPrior;
  return betaMean(prior.alpha + evidence.support, prior.beta + evidence.contradict);
}

/** Weight of one installation's report or vote. */
export function installationWeight(trust: CommunityInstallationTrust, evidence: Evidence): number {
  return COMMUNITY_TRUST_RULES.trustFactor[trust] * installationCredibility(evidence);
}

/**
 * Updates a reporter's evidence after another installation votes on their report. Decays the
 * stored evidence to `elapsedMs` first, then adds the voter's weight (doubled when contradicted).
 */
export function applyReporterOutcome(
  evidence: Evidence,
  elapsedMs: number,
  vote: CommunityReportVoteValue,
  voterWeight: number,
): Evidence {
  const decayed = decayEvidence(
    evidence,
    elapsedMs,
    COMMUNITY_TRUST_RULES.installationEvidenceHalfLifeMs,
  );
  return vote === 'present'
    ? { ...decayed, support: decayed.support + voterWeight }
    : {
        ...decayed,
        contradict: decayed.contradict + voterWeight * COMMUNITY_TRUST_RULES.contradictionPenalty,
      };
}

export interface ReportEvidenceInput {
  createdAt: Date;
  now: Date;
  reporterTrust: CommunityInstallationTrust;
  reporterWeight: number;
  votes: readonly { createdAt: Date; vote: CommunityReportVoteValue; weight: number }[];
}

export interface ReportAssessment {
  /** Decayed weighted contradicting evidence. */
  contradict: number;
  /** Distinct installations currently supporting the report, the reporter included. */
  independentDevices: number;
  lowerBound: number;
  mean: number;
  /** Present votes from other installations. */
  presentVotes: number;
  /** Decayed weighted supporting evidence, the reporter included. */
  support: number;
}

export function assessReport(input: ReportEvidenceInput): ReportAssessment {
  const halfLife = COMMUNITY_TRUST_RULES.reportEvidenceHalfLifeMs;
  const decayed = (weight: number, at: Date): number =>
    decayEvidence({ contradict: 0, support: weight }, input.now.getTime() - at.getTime(), halfLife)
      .support;
  let support = decayed(input.reporterWeight, input.createdAt);
  let contradict = 0;
  let presentVotes = 0;
  for (const vote of input.votes) {
    if (vote.vote === 'present') {
      support += decayed(vote.weight, vote.createdAt);
      presentVotes += 1;
    } else {
      contradict += decayed(vote.weight, vote.createdAt);
    }
  }
  const prior = COMMUNITY_TRUST_RULES.reportPrior;
  const alpha = prior.alpha + support;
  const beta = prior.beta + contradict;
  return {
    contradict,
    independentDevices: 1 + presentVotes,
    lowerBound: betaLowerBound(alpha, beta, COMMUNITY_TRUST_RULES.lowerBoundZ),
    mean: betaMean(alpha, beta),
    presentVotes,
    support,
  };
}

export type ReportVisibility =
  | { visible: false }
  | { confirmations: 0; state: 'unconfirmed'; visible: true }
  | { confirmations: number; state: 'confirmed'; visible: true };

export function isCorroborated(assessment: ReportAssessment): boolean {
  return (
    assessment.lowerBound >= COMMUNITY_TRUST_RULES.minimumLowerBound &&
    assessment.independentDevices >= COMMUNITY_TRUST_RULES.minimumIndependentDevices
  );
}

/** Decides what, if anything, other drivers see for one report under a publication policy. */
export function reportVisibility(
  publication: CommunityReportPublication,
  input: ReportEvidenceInput,
): ReportVisibility {
  if (publication === 'shadow') return { visible: false };
  const assessment = assessReport(input);
  if (isCorroborated(assessment)) {
    return { confirmations: assessment.presentVotes, state: 'confirmed', visible: true };
  }
  if (
    publication === 'attested' &&
    input.reporterTrust === 'attested' &&
    input.reporterWeight >= COMMUNITY_TRUST_RULES.minimumSingleReporterWeight &&
    assessment.mean > 0.5
  ) {
    return { confirmations: 0, state: 'unconfirmed', visible: true };
  }
  return { visible: false };
}

/**
 * New expiry after a vote. "Present" extends to two hours from now (capped at the maximum
 * lifetime); "not present" halves the remaining time and ends the report outright once
 * contradiction outweighs support two to one.
 */
export function expiryAfterVote(input: {
  assessment: ReportAssessment;
  createdAt: Date;
  expiresAt: Date;
  now: Date;
  vote: CommunityReportVoteValue;
}): Date {
  const now = input.now.getTime();
  const expiresAt = input.expiresAt.getTime();
  if (input.vote === 'present') {
    const cap = input.createdAt.getTime() + COMMUNITY_TRUST_RULES.maximumReportLifetimeMs;
    return new Date(
      Math.max(expiresAt, Math.min(now + COMMUNITY_TRUST_RULES.reportLifetimeMs, cap)),
    );
  }
  if (input.assessment.contradict >= 2 * input.assessment.support) return new Date(now);
  return new Date(now + Math.max(0, expiresAt - now) / 2);
}

const EARTH_RADIUS_METERS = 6_371_008.8;

export function distanceMeters(from: LatLng, to: LatLng): number {
  const toRadians = (degrees: number): number => (degrees * Math.PI) / 180;
  const deltaLatitude = toRadians(to.latitude - from.latitude);
  const deltaLongitude = toRadians(to.longitude - from.longitude);
  const a =
    Math.sin(deltaLatitude / 2) ** 2 +
    Math.cos(toRadians(from.latitude)) *
      Math.cos(toRadians(to.latitude)) *
      Math.sin(deltaLongitude / 2) ** 2;
  return 2 * EARTH_RADIUS_METERS * Math.asin(Math.min(1, Math.sqrt(a)));
}

/** Coarse position kept per installation for the travel check (about 1 km). */
export function coarsenForTravelCheck(point: LatLng): LatLng {
  return {
    latitude: Math.round(point.latitude * 100) / 100,
    longitude: Math.round(point.longitude * 100) / 100,
  };
}

/** Position shown to other drivers: four decimals (about 11 m), enough to place it on a road. */
export function coarsenForPublication(point: LatLng): LatLng {
  return {
    latitude: Math.round(point.latitude * 10_000) / 10_000,
    longitude: Math.round(point.longitude * 10_000) / 10_000,
  };
}

/** Rate-limit cell (0.01 x 0.01 degree, roughly 1.1 km x 0.7 km in Alberta and BC). */
export function rateLimitCell(point: LatLng): string {
  return `${String(Math.floor(point.latitude * 100))}:${String(Math.floor(point.longitude * 100))}`;
}

export function isImpossibleTravel(input: {
  from: LatLng;
  fromAt: Date;
  to: LatLng;
  toAt: Date;
}): boolean {
  const distance = Math.max(
    0,
    distanceMeters(input.from, input.to) - COMMUNITY_TRUST_RULES.travelSlackMeters,
  );
  if (distance === 0) return false;
  const seconds = Math.max(1, (input.toAt.getTime() - input.fromAt.getTime()) / 1_000);
  return distance / seconds > COMMUNITY_TRUST_RULES.maximumTravelSpeedMetersPerSecond;
}

export type WriteLimitViolation = 'installation' | 'category' | 'cell';

/** Checks counts already recorded in the last hour (cell: last ten minutes) against limits. */
export function reportLimitViolation(input: {
  cellReportsLastTenMinutes: number;
  installationReportsLastHour: number;
  sameTypeReportsLastHour: number;
  trust: CommunityInstallationTrust;
}): WriteLimitViolation | undefined {
  const limits = COMMUNITY_WRITE_LIMITS[input.trust];
  if (input.installationReportsLastHour >= limits.reportsPerHour) return 'installation';
  if (input.sameTypeReportsLastHour >= limits.reportsPerTypePerHour) return 'category';
  if (input.cellReportsLastTenMinutes >= COMMUNITY_WRITE_LIMITS.cellReportsPerTenMinutes) {
    return 'cell';
  }
  return undefined;
}

export function voteLimitExceeded(
  trust: CommunityInstallationTrust,
  installationVotesLastHour: number,
): boolean {
  return installationVotesLastHour >= COMMUNITY_WRITE_LIMITS[trust].votesPerHour;
}

/** Network risk bucket: IPv4 /24 or IPv6 /48. Only ever used as an in-memory salted hash key. */
export function networkBucket(address: string): string {
  const ipv4 = /^(?:::ffff:)?(\d{1,3}\.\d{1,3}\.\d{1,3})\.\d{1,3}$/i.exec(address);
  if (ipv4?.[1] !== undefined) return `v4:${ipv4[1]}`;
  const groups = address.toLowerCase().split('::')[0]?.split(':') ?? [];
  return `v6:${groups.slice(0, 3).join(':')}`;
}
