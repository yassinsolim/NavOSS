import { describe, expect, it } from 'vitest';

import {
  communityAssertionClientData,
  CommunityReportResponseSchema,
  CommunityReportSubmissionRequestSchema,
  CommunityReportTypeSchema,
} from '../src/index.js';

const assertion = {
  assertion: 'b2NjdXJyZW5jZWFzc2VydGlvbg==',
  challenge: 'A'.repeat(43),
  keyId: 'a2V5aWRrZXlpZA==',
};

const report = {
  coordinate: { latitude: 51.0447, longitude: -114.0719 },
  expiresAt: '2026-11-12T20:00:00Z',
  id: '6c0b7c0e-8d7b-4a39-9f43-0a2d9b2f0f11',
  reportedAt: '2026-11-12T18:00:00Z',
  source: 'navoss-community',
  type: 'collision',
};

describe('community report contracts', () => {
  it('accepts the phone draft types and refuses police or speed-trap reports', () => {
    expect(CommunityReportTypeSchema.options).toEqual([
      'collision',
      'road-closure',
      'slow-traffic',
      'construction',
      'pothole',
      'object-on-road',
      'road-hazard',
      'stalled-vehicle',
    ]);
    expect(CommunityReportTypeSchema.safeParse('police').success).toBe(false);
    expect(CommunityReportTypeSchema.safeParse('speed-trap').success).toBe(false);
  });

  it('rejects free text on a submission', () => {
    const result = CommunityReportSubmissionRequestSchema.safeParse({
      assertion,
      coordinate: { latitude: 51.0447, longitude: -114.0719 },
      description: 'officer behind the overpass',
      type: 'road-hazard',
    });
    expect(result.success).toBe(false);
  });

  it('labels unconfirmed reports with zero confirmations and confirmed ones with at least one', () => {
    const parse = (value: object) =>
      CommunityReportResponseSchema.safeParse({
        generatedAt: '2026-11-12T18:05:00Z',
        publication: 'attested',
        reports: [{ ...report, ...value }],
      }).success;
    expect(parse({ confirmations: 0, state: 'unconfirmed' })).toBe(true);
    expect(parse({ confirmations: 2, state: 'unconfirmed' })).toBe(false);
    expect(parse({ confirmations: 1, state: 'confirmed' })).toBe(true);
    expect(parse({ confirmations: 0, state: 'confirmed' })).toBe(false);
  });

  it('binds client data to the operation, challenge, and rounded coordinate', () => {
    const submit = communityAssertionClientData('c1', {
      coordinate: { latitude: 51.04471234, longitude: -114.0719 },
      kind: 'submit-report',
      type: 'pothole',
    });
    expect(submit).toBe(
      'navoss-community-v1\nsubmit-report\nc1\npothole\n51.044712\n-114.071900\n-',
    );
    expect(
      communityAssertionClientData('c1', {
        kind: 'vote',
        observedAt: { latitude: 51, longitude: -114 },
        reportId: report.id,
        vote: 'not-present',
      }),
    ).toBe(`navoss-community-v1\nvote\nc1\n${report.id}\nnot-present\n51.000000\n-114.000000`);
    expect(communityAssertionClientData('c2', { kind: 'delete-installation' })).not.toBe(
      communityAssertionClientData('c1', { kind: 'delete-installation' }),
    );
  });
});
