import { z } from 'zod/v4';

import { CoordinateSchema, IsoDateTimeSchema, LatitudeSchema, LongitudeSchema } from './common.js';

/**
 * Structured community road-report types. These match the phone's local draft types. Police,
 * checkpoint and speed-trap reports, free text, and photos are deliberately not representable.
 */
export const CommunityReportTypeSchema = z.enum([
  'collision',
  'road-closure',
  'slow-traffic',
  'construction',
  'pothole',
  'object-on-road',
  'road-hazard',
  'stalled-vehicle',
]);

/** Server publication policy for community reports. */
export const CommunityReportPublicationSchema = z.enum(['shadow', 'corroborated', 'attested']);

export const CommunityInstallationTrustSchema = z.enum(['attested', 'untrusted']);

const Base64UrlChallengeSchema = z
  .base64url()
  .length(43)
  .describe('One-use 32-byte server challenge, unpadded base64url');

const KeyIdSchema = z
  .base64()
  .min(4)
  .max(128)
  .describe('App Attest key identifier exactly as returned by DCAppAttestService (base64)');

export const CommunityChallengeResponseSchema = z
  .object({
    challenge: Base64UrlChallengeSchema,
    expiresAt: IsoDateTimeSchema,
  })
  .strict();

/**
 * Registers a pseudonymous installation. Production builds send an App Attest attestation of
 * SHA-256(UTF-8 challenge). Simulator and development builds may only register a software P-256
 * key when the server explicitly allows development attestation; such installations are untrusted.
 */
export const CommunityInstallationRegistrationRequestSchema = z.discriminatedUnion('kind', [
  z
    .object({
      attestationObject: z.base64().min(16).max(16_384),
      challenge: Base64UrlChallengeSchema,
      keyId: KeyIdSchema,
      kind: z.literal('app-attest'),
    })
    .strict(),
  z
    .object({
      challenge: Base64UrlChallengeSchema,
      keyId: KeyIdSchema,
      kind: z.literal('development'),
      publicKey: z
        .base64()
        .min(16)
        .max(512)
        .describe('Software P-256 public key, DER SubjectPublicKeyInfo (base64)'),
    })
    .strict(),
]);

export const CommunityInstallationRegistrationResponseSchema = z
  .object({
    registeredAt: IsoDateTimeSchema,
    status: z.literal('registered'),
    trust: CommunityInstallationTrustSchema,
  })
  .strict();

/**
 * Every write carries a fresh assertion. `assertion` is the CBOR object produced by
 * DCAppAttestService.generateAssertion for SHA-256 of `communityAssertionClientData(...)`.
 */
export const CommunityAssertionSchema = z
  .object({
    assertion: z.base64().min(16).max(4_096),
    challenge: Base64UrlChallengeSchema,
    keyId: KeyIdSchema,
  })
  .strict();

export const CommunityReportSubmissionRequestSchema = z
  .object({
    assertion: CommunityAssertionSchema,
    coordinate: CoordinateSchema,
    heading: z.number().int().min(0).max(359).optional(),
    type: CommunityReportTypeSchema,
  })
  .strict();

export const CommunityReportSubmissionResponseSchema = z
  .object({
    expiresAt: IsoDateTimeSchema,
    reportId: z.uuid(),
    status: z.enum(['accepted', 'merged']),
  })
  .strict();

export const CommunityReportVoteValueSchema = z.enum(['present', 'not-present']);

export const CommunityReportVoteRequestSchema = z
  .object({
    assertion: CommunityAssertionSchema,
    observedAt: CoordinateSchema.describe(
      'Fresh device coordinate used only for the proximity check and then discarded',
    ),
    vote: CommunityReportVoteValueSchema,
  })
  .strict();

export const CommunityReportVoteResponseSchema = z
  .object({
    active: z.boolean(),
    reportId: z.uuid(),
    status: z.literal('recorded'),
  })
  .strict();

export const CommunityReportParamsSchema = z.object({ reportId: z.uuid() }).strict();

export const CommunityAssertedRequestSchema = z
  .object({ assertion: CommunityAssertionSchema })
  .strict();

export const CommunityDeletionResponseSchema = z.object({ status: z.literal('deleted') }).strict();

export const CommunityReportQuerySchema = z
  .object({
    east: z.coerce.number().pipe(LongitudeSchema),
    north: z.coerce.number().pipe(LatitudeSchema),
    south: z.coerce.number().pipe(LatitudeSchema),
    west: z.coerce.number().pipe(LongitudeSchema),
  })
  .strict()
  .superRefine((query, context) => {
    if (query.north <= query.south) {
      context.addIssue({ code: 'custom', message: 'north must exceed south', path: ['north'] });
    }
    if (query.east <= query.west) {
      context.addIssue({ code: 'custom', message: 'east must exceed west', path: ['east'] });
    }
    if (query.north - query.south > 0.5 || query.east - query.west > 0.5) {
      context.addIssue({
        code: 'custom',
        message: 'bounding box must span at most 0.5 degrees on each axis',
        path: ['north'],
      });
    }
  });

const CommunityReportBaseShape = {
  coordinate: CoordinateSchema.describe(
    'Report position snapped to a 0.0005-degree grid (about 55 m by 35 m)',
  ),
  expiresAt: IsoDateTimeSchema.describe('Expiry rounded up to five minutes'),
  id: z.uuid(),
  reportedAt: IsoDateTimeSchema.describe('Report time rounded down to five minutes'),
  source: z.literal('navoss-community'),
  type: CommunityReportTypeSchema,
} as const;

/** A community report is never official data and never changes routes by itself. */
export const CommunityReportSchema = z.discriminatedUnion('state', [
  z
    .object({
      ...CommunityReportBaseShape,
      confirmations: z.literal(0),
      state: z.literal('unconfirmed'),
    })
    .strict(),
  z
    .object({
      ...CommunityReportBaseShape,
      confirmations: z.number().int().min(1),
      state: z.literal('confirmed'),
    })
    .strict(),
]);

export const CommunityReportResponseSchema = z
  .object({
    generatedAt: IsoDateTimeSchema,
    publication: CommunityReportPublicationSchema,
    reports: z.array(CommunityReportSchema).max(200),
  })
  .strict();

export type CommunityAssertion = z.infer<typeof CommunityAssertionSchema>;
export type CommunityChallengeResponse = z.infer<typeof CommunityChallengeResponseSchema>;
export type CommunityInstallationRegistrationRequest = z.infer<
  typeof CommunityInstallationRegistrationRequestSchema
>;
export type CommunityInstallationRegistrationResponse = z.infer<
  typeof CommunityInstallationRegistrationResponseSchema
>;
export type CommunityInstallationTrust = z.infer<typeof CommunityInstallationTrustSchema>;
export type CommunityReport = z.infer<typeof CommunityReportSchema>;
export type CommunityReportPublication = z.infer<typeof CommunityReportPublicationSchema>;
export type CommunityReportQuery = z.infer<typeof CommunityReportQuerySchema>;
export type CommunityReportResponse = z.infer<typeof CommunityReportResponseSchema>;
export type CommunityReportSubmissionRequest = z.infer<
  typeof CommunityReportSubmissionRequestSchema
>;
export type CommunityReportSubmissionResponse = z.infer<
  typeof CommunityReportSubmissionResponseSchema
>;
export type CommunityReportType = z.infer<typeof CommunityReportTypeSchema>;
export type CommunityReportVoteRequest = z.infer<typeof CommunityReportVoteRequestSchema>;
export type CommunityReportVoteResponse = z.infer<typeof CommunityReportVoteResponseSchema>;
export type CommunityReportVoteValue = z.infer<typeof CommunityReportVoteValueSchema>;

export type CommunityAssertedOperation =
  | {
      coordinate: { latitude: number; longitude: number };
      heading?: number | undefined;
      kind: 'submit-report';
      type: CommunityReportType;
    }
  | {
      kind: 'vote';
      observedAt: { latitude: number; longitude: number };
      reportId: string;
      vote: CommunityReportVoteValue;
    }
  | { kind: 'delete-report'; reportId: string }
  | { kind: 'delete-installation' }
  /** Exchanges the assertion for a short-lived community-traffic upload credential. */
  | { kind: 'traffic-credential' };

function formatDegrees(value: number): string {
  return value.toFixed(6);
}

/**
 * Canonical client data bound into every write assertion. The client signs
 * SHA-256(UTF-8(result)); the server rebuilds the same string from the validated request, so an
 * assertion cannot be moved to a different operation, report, vote, or coordinate.
 */
export function communityAssertionClientData(
  challenge: string,
  operation: CommunityAssertedOperation,
): string {
  const fields: string[] = ['navoss-community-v1', operation.kind, challenge];
  switch (operation.kind) {
    case 'submit-report':
      fields.push(
        operation.type,
        formatDegrees(operation.coordinate.latitude),
        formatDegrees(operation.coordinate.longitude),
        operation.heading === undefined ? '-' : String(operation.heading),
      );
      break;
    case 'vote':
      fields.push(
        operation.reportId,
        operation.vote,
        formatDegrees(operation.observedAt.latitude),
        formatDegrees(operation.observedAt.longitude),
      );
      break;
    case 'delete-report':
      fields.push(operation.reportId);
      break;
    case 'delete-installation':
    case 'traffic-credential':
      break;
  }
  return fields.join('\n');
}
