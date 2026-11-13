import { describe, expect, it } from 'vitest';

import {
  applyReporterOutcome,
  assessReport,
  betaLowerBound,
  cellLockKeys,
  coarsenForPublication,
  COMMUNITY_TRUST_RULES,
  decayEvidence,
  expiryAfterVote,
  installationWeight,
  isImpossibleTravel,
  networkBucket,
  publicExpiresAt,
  publicReportedAt,
  rateLimitCell,
  reportLimitViolation,
  reportVisibility,
  voteLimitExceeded,
  type ReportEvidenceInput,
} from '../src/community-trust.js';

const CREATED = new Date('2026-11-12T18:00:00Z');
const minutes = (count: number): Date => new Date(CREATED.getTime() + count * 60_000);
const NEW_ATTESTED_WEIGHT = installationWeight('attested', { contradict: 0, support: 0 });
const NEW_UNTRUSTED_WEIGHT = installationWeight('untrusted', { contradict: 0, support: 0 });

function report(overrides: Partial<ReportEvidenceInput> = {}): ReportEvidenceInput {
  return {
    createdAt: CREATED,
    now: minutes(5),
    reporterTrust: 'attested',
    reporterWeight: NEW_ATTESTED_WEIGHT,
    votes: [],
    ...overrides,
  };
}

describe('credibility', () => {
  it('starts new installations at low influence and untrusted ones lower still', () => {
    expect(NEW_ATTESTED_WEIGHT).toBeCloseTo(0.5);
    expect(NEW_UNTRUSTED_WEIGHT).toBeCloseTo(0.125);
  });

  it('penalizes contradiction more than it rewards agreement', () => {
    const supported = applyReporterOutcome({ contradict: 0, support: 0 }, 0, 'present', 0.5);
    const contradicted = applyReporterOutcome({ contradict: 0, support: 0 }, 0, 'not-present', 0.5);
    const gain = installationWeight('attested', supported) - NEW_ATTESTED_WEIGHT;
    const loss = NEW_ATTESTED_WEIGHT - installationWeight('attested', contradicted);
    expect(gain).toBeGreaterThan(0);
    expect(loss).toBeGreaterThan(gain);
  });

  it('decays stale evidence by half each half-life', () => {
    expect(
      decayEvidence(
        { contradict: 2, support: 4 },
        COMMUNITY_TRUST_RULES.installationEvidenceHalfLifeMs,
        COMMUNITY_TRUST_RULES.installationEvidenceHalfLifeMs,
      ),
    ).toEqual({ contradict: 1, support: 2 });
  });

  it('keeps the lower bound below the mean and within [0, 1]', () => {
    expect(betaLowerBound(2, 1, 1)).toBeLessThan(2 / 3);
    expect(betaLowerBound(1, 1, 3)).toBe(0);
  });
});

describe('publication policy', () => {
  const confirmedVotes = [
    { createdAt: minutes(2), trust: 'attested' as const, vote: 'present' as const, weight: 0.5 },
  ];

  it('never publishes in shadow mode, however corroborated', () => {
    expect(reportVisibility('shadow', report({ votes: confirmedVotes }))).toEqual({
      visible: false,
    });
  });

  it('requires independent corroboration in corroborated mode', () => {
    expect(reportVisibility('corroborated', report())).toEqual({ visible: false });
    expect(reportVisibility('corroborated', report({ votes: confirmedVotes }))).toEqual({
      confirmations: 1,
      state: 'confirmed',
      visible: true,
    });
  });

  it('shows a single attested report as unconfirmed with zero confirmations in attested mode', () => {
    expect(reportVisibility('attested', report())).toEqual({
      confirmations: 0,
      state: 'unconfirmed',
      visible: true,
    });
    expect(reportVisibility('attested', report({ votes: confirmedVotes }))).toMatchObject({
      state: 'confirmed',
    });
  });

  it('does not show single reports from untrusted or discredited installations', () => {
    expect(
      reportVisibility(
        'attested',
        report({ reporterTrust: 'untrusted', reporterWeight: NEW_UNTRUSTED_WEIGHT }),
      ),
    ).toEqual({ visible: false });
    expect(reportVisibility('attested', report({ reporterWeight: 0.2 }))).toEqual({
      visible: false,
    });
  });

  it('hides a single report as soon as an equal-weight driver says it is gone', () => {
    expect(
      reportVisibility(
        'attested',
        report({
          votes: [{ createdAt: minutes(3), trust: 'attested', vote: 'not-present', weight: 0.5 }],
        }),
      ),
    ).toEqual({ visible: false });
  });

  it('ignores untrusted evidence however much of it there is', () => {
    const untrusted = (vote: 'present' | 'not-present') =>
      Array.from({ length: 20 }, (_, index) => ({
        createdAt: minutes(1 + index / 10),
        trust: 'untrusted' as const,
        vote,
        weight: 1,
      }));
    // Twenty software-key confirmations of an untrusted report publish nothing.
    expect(
      reportVisibility(
        'corroborated',
        report({ reporterTrust: 'untrusted', votes: untrusted('present') }),
      ),
    ).toEqual({ visible: false });
    // Twenty software-key denials cannot hide or weaken an attested report.
    const attacked = report({ votes: untrusted('not-present') });
    expect(reportVisibility('attested', attacked)).toEqual({
      confirmations: 0,
      state: 'unconfirmed',
      visible: true,
    });
    expect(assessReport(attacked).contradict).toBe(0);
  });

  it('does not let one untrusted confirmation corroborate a report', () => {
    expect(
      reportVisibility(
        'corroborated',
        report({
          votes: [{ createdAt: minutes(2), trust: 'untrusted', vote: 'present', weight: 0.5 }],
        }),
      ),
    ).toEqual({ visible: false });
  });

  it('lets corroboration fade when nobody reconfirms', () => {
    expect(
      reportVisibility('corroborated', report({ now: minutes(150), votes: confirmedVotes })),
    ).toEqual({ visible: false });
  });
});

describe('expiry', () => {
  it('extends on confirmation up to the maximum lifetime and shortens on contradiction', () => {
    const assessment = assessReport(report());
    const expiresAt = minutes(120);
    expect(
      expiryAfterVote({
        assessment,
        createdAt: CREATED,
        expiresAt,
        now: minutes(60),
        vote: 'present',
      }),
    ).toEqual(minutes(180));
    expect(
      expiryAfterVote({
        assessment,
        createdAt: CREATED,
        expiresAt: minutes(700),
        now: minutes(690),
        vote: 'present',
      }),
    ).toEqual(minutes(720));
    expect(
      expiryAfterVote({
        assessment,
        createdAt: CREATED,
        expiresAt,
        now: minutes(60),
        vote: 'not-present',
      }),
    ).toEqual(minutes(90));
  });

  it('ends a report immediately once contradiction dominates', () => {
    const assessment = assessReport(
      report({
        votes: [
          { createdAt: minutes(1), trust: 'attested', vote: 'not-present', weight: 1 },
          { createdAt: minutes(2), trust: 'attested', vote: 'not-present', weight: 1 },
        ],
      }),
    );
    expect(
      expiryAfterVote({
        assessment,
        createdAt: CREATED,
        expiresAt: minutes(120),
        now: minutes(5),
        vote: 'not-present',
      }),
    ).toEqual(minutes(5));
  });
});

describe('abuse limits', () => {
  it('rejects travel faster than a car can drive, allowing for coarse positions', () => {
    const calgary = { latitude: 51.0447, longitude: -114.0719 };
    const kelowna = { latitude: 49.888, longitude: -119.496 };
    expect(
      isImpossibleTravel({ from: calgary, fromAt: CREATED, to: kelowna, toAt: minutes(30) }),
    ).toBe(true);
    expect(
      isImpossibleTravel({ from: calgary, fromAt: CREATED, to: kelowna, toAt: minutes(400) }),
    ).toBe(false);
    expect(
      isImpossibleTravel({
        from: calgary,
        fromAt: CREATED,
        to: { latitude: 51.05, longitude: -114.07 },
        toAt: CREATED,
      }),
    ).toBe(false);
  });

  it('applies installation, category, and cell limits, much lower when untrusted', () => {
    const base = {
      cellReportsLastTenMinutes: 0,
      installationReportsLastHour: 0,
      sameTypeReportsLastHour: 0,
    };
    expect(reportLimitViolation({ ...base, trust: 'attested' })).toBeUndefined();
    expect(
      reportLimitViolation({ ...base, installationReportsLastHour: 2, trust: 'untrusted' }),
    ).toBe('installation');
    expect(reportLimitViolation({ ...base, sameTypeReportsLastHour: 3, trust: 'attested' })).toBe(
      'category',
    );
    expect(
      reportLimitViolation({ ...base, cellReportsLastTenMinutes: 12, trust: 'attested' }),
    ).toBe('cell');
    expect(voteLimitExceeded('untrusted', 5)).toBe(true);
    expect(voteLimitExceeded('attested', 5)).toBe(false);
  });

  it('groups nearby coordinates into one cell and networks into coarse buckets', () => {
    expect(rateLimitCell({ latitude: 51.0447, longitude: -114.0719 })).toBe(
      rateLimitCell({ latitude: 51.0449, longitude: -114.0711 }),
    );
    expect(networkBucket('203.0.113.7')).toBe(networkBucket('::ffff:203.0.113.200'));
    expect(networkBucket('2001:db8:1:2::1')).toBe(networkBucket('2001:db8:1:ffff::2'));
  });

  it('keys every textual form of one IPv6 /48 to one network bucket', () => {
    // The same /48 written with different compressions once produced different buckets, so
    // rotating host or subnet bits bought a fresh quota.
    const bucket = networkBucket('2001:db8::1');
    for (const address of [
      '2001:db8:0:1::1',
      '2001:0db8:0000:ffff:0000:0000:0000:0002',
      '2001:DB8::abcd:1',
      '2001:db8:0::',
      '2001:db8::1%en0',
    ]) {
      expect(networkBucket(address)).toBe(bucket);
    }
    expect(networkBucket('2001:db8:1::1')).not.toBe(bucket);
    expect(networkBucket('2001:db9::1')).not.toBe(bucket);
    // IPv4-mapped addresses in either spelling share the IPv4 /24.
    expect(networkBucket('::ffff:c000:0201')).toBe(networkBucket('192.0.2.77'));
    expect(networkBucket('::FFFF:192.0.2.9')).toBe(networkBucket('192.0.2.77'));
    expect(networkBucket('::1')).toBe(networkBucket('0:0:0::1'));
  });
});

describe('publication coarsening', () => {
  it('snaps published positions to a grid coarser than a residential parcel', () => {
    expect(coarsenForPublication({ latitude: 51.044712, longitude: -114.071883 })).toEqual({
      latitude: 51.0445,
      longitude: -114.072,
    });
    // Nearby but distinct driveways collapse onto the same published point.
    expect(coarsenForPublication({ latitude: 51.04462, longitude: -114.07185 })).toEqual(
      coarsenForPublication({ latitude: 51.04441, longitude: -114.07209 }),
    );
  });

  it('rounds public times to five minutes so expiry cannot reveal the creation instant', () => {
    const created = new Date('2026-11-12T18:03:27.123Z');
    const expires = new Date(created.getTime() + COMMUNITY_TRUST_RULES.reportLifetimeMs);
    expect(publicReportedAt(created).toISOString()).toBe('2026-11-12T18:00:00.000Z');
    expect(publicExpiresAt(expires).toISOString()).toBe('2026-11-12T20:05:00.000Z');
    expect(
      publicExpiresAt(
        new Date(
          new Date('2026-11-12T18:01:00Z').getTime() + COMMUNITY_TRUST_RULES.reportLifetimeMs,
        ),
      ),
    ).toEqual(publicExpiresAt(expires));
  });

  it('gives any two mergeable submissions a shared cell lock', () => {
    const west = { latitude: 51.04999, longitude: -114.07001 };
    const east = { latitude: 51.05001, longitude: -114.06999 };
    const westKeys = new Set(cellLockKeys(west).map((key) => key.join(':')));
    expect(cellLockKeys(east).some((key) => westKeys.has(key.join(':')))).toBe(true);
    const sorted = [...cellLockKeys(west)].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    expect(cellLockKeys(west)).toEqual(sorted);
  });
});
