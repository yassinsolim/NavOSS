import { createHash, randomBytes } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  AppAttestError,
  createAppAttestVerifier,
  type AppAttestFailure,
} from '../src/app-attest.js';
import { CborError, decodeCbor } from '../src/cbor.js';
import {
  createTestAppAttestAuthority,
  encodeCbor,
  type CborInput,
} from './support/app-attest-fixture.js';

const TEAM_ID = 'ABCDE12345';
const BUNDLE_ID = 'org.navoss.mobile';
const NOW = new Date('2026-11-12T18:00:00Z');

const sha256 = (value: string): Buffer => createHash('sha256').update(value, 'utf8').digest();

function expectFailure(work: () => unknown, reason: AppAttestFailure): void {
  let caught: unknown;
  try {
    work();
  } catch (error: unknown) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(AppAttestError);
  expect((caught as AppAttestError).reason).toBe(reason);
}

describe('decodeCbor', () => {
  it('decodes nested maps, arrays, and byte strings', () => {
    const encoded = encodeCbor(
      new Map<string, CborInput>([
        ['fmt', 'apple-appattest'],
        ['list', [1, 300, Buffer.from([1, 2])]],
      ]),
    );
    const decoded = decodeCbor(encoded);
    expect(decoded).toBeInstanceOf(Map);
    const map = decoded as Map<string, unknown>;
    expect(map.get('fmt')).toBe('apple-appattest');
    expect(map.get('list')).toEqual([1, 300, Uint8Array.from([1, 2])]);
  });

  it('rejects trailing bytes, truncation, and indefinite lengths', () => {
    expect(() => decodeCbor(Buffer.from([0x01, 0x02]))).toThrow(CborError);
    expect(() => decodeCbor(Buffer.from([0x58, 0x10, 0x00]))).toThrow(CborError);
    expect(() => decodeCbor(Buffer.from([0x9f, 0xff]))).toThrow(CborError);
  });
});

describe('App Attest attestation', () => {
  const authority = createTestAppAttestAuthority({ bundleId: BUNDLE_ID, teamId: TEAM_ID });
  const verifier = createAppAttestVerifier({
    bundleId: BUNDLE_ID,
    environment: 'production',
    rootCertificatePem: authority.rootPem,
    teamId: TEAM_ID,
  });

  it('accepts a genuine attestation chained to the configured root', () => {
    const device = authority.createDevice();
    const challenge = randomBytes(32).toString('base64url');
    const verified = verifier.verifyAttestation({
      attestationObject: Buffer.from(device.attest(challenge), 'base64'),
      clientDataHash: sha256(challenge),
      keyId: Buffer.from(device.keyId, 'base64'),
      now: NOW,
    });
    expect(verified.signCount).toBe(0);
    expect(verified.publicKey.length).toBeGreaterThan(60);
  });

  it('rejects the test chain under the production Apple root', () => {
    const production = createAppAttestVerifier({
      bundleId: BUNDLE_ID,
      environment: 'production',
      teamId: TEAM_ID,
    });
    const device = authority.createDevice();
    expectFailure(
      () =>
        production.verifyAttestation({
          attestationObject: Buffer.from(device.attest('challenge'), 'base64'),
          clientDataHash: sha256('challenge'),
          keyId: Buffer.from(device.keyId, 'base64'),
          now: NOW,
        }),
      'certificate',
    );
  });

  it('rejects a different challenge, team, key id, environment, counter, or expired leaf', () => {
    const device = authority.createDevice();
    const keyId = Buffer.from(device.keyId, 'base64');
    const attestation = Buffer.from(device.attest('right'), 'base64');

    expectFailure(
      () =>
        verifier.verifyAttestation({
          attestationObject: attestation,
          clientDataHash: sha256('wrong'),
          keyId,
          now: NOW,
        }),
      'nonce',
    );
    expectFailure(
      () =>
        createAppAttestVerifier({
          bundleId: BUNDLE_ID,
          environment: 'production',
          rootCertificatePem: authority.rootPem,
          teamId: 'ZZZZZ99999',
        }).verifyAttestation({
          attestationObject: attestation,
          clientDataHash: sha256('right'),
          keyId,
          now: NOW,
        }),
      'app-id',
    );
    expectFailure(
      () =>
        verifier.verifyAttestation({
          attestationObject: attestation,
          clientDataHash: sha256('right'),
          keyId: Buffer.from(authority.createDevice().keyId, 'base64'),
          now: NOW,
        }),
      'key-id',
    );
    expectFailure(
      () =>
        verifier.verifyAttestation({
          attestationObject: Buffer.from(
            device.attest('dev', { aaguid: Buffer.from('appattestdevelop') }),
            'base64',
          ),
          clientDataHash: sha256('dev'),
          keyId,
          now: NOW,
        }),
      'environment',
    );
    expectFailure(
      () =>
        verifier.verifyAttestation({
          attestationObject: Buffer.from(device.attest('count', { counter: 1 }), 'base64'),
          clientDataHash: sha256('count'),
          keyId,
          now: NOW,
        }),
      'counter',
    );
    const expired = authority.createDevice({ leafNotAfter: new Date('2026-01-01T00:00:00Z') });
    expectFailure(
      () =>
        verifier.verifyAttestation({
          attestationObject: Buffer.from(expired.attest('late'), 'base64'),
          clientDataHash: sha256('late'),
          keyId: Buffer.from(expired.keyId, 'base64'),
          now: NOW,
        }),
      'certificate',
    );
    expectFailure(
      () =>
        verifier.verifyAttestation({
          attestationObject: Buffer.from('not cbor at all'),
          clientDataHash: sha256('right'),
          keyId,
          now: NOW,
        }),
      'malformed',
    );
  });
});

describe('App Attest assertions', () => {
  const authority = createTestAppAttestAuthority({ bundleId: BUNDLE_ID, teamId: TEAM_ID });
  const verifier = createAppAttestVerifier({
    bundleId: BUNDLE_ID,
    environment: 'production',
    rootCertificatePem: authority.rootPem,
    teamId: TEAM_ID,
  });
  const device = authority.createDevice();
  const { publicKey } = verifier.verifyAttestation({
    attestationObject: Buffer.from(device.attest('register'), 'base64'),
    clientDataHash: sha256('register'),
    keyId: Buffer.from(device.keyId, 'base64'),
    now: NOW,
  });

  it('accepts an increasing counter and rejects a replayed or rolled-back one', () => {
    const first = Buffer.from(device.assert('payload'), 'base64');
    expect(
      verifier.verifyAssertion({
        assertion: first,
        clientDataHash: sha256('payload'),
        previousSignCount: 0,
        publicKey,
      }),
    ).toEqual({ signCount: 1 });
    expectFailure(
      () =>
        verifier.verifyAssertion({
          assertion: first,
          clientDataHash: sha256('payload'),
          previousSignCount: 1,
          publicKey,
        }),
      'counter',
    );
  });

  it('rejects an assertion over different client data or from another key', () => {
    const assertion = Buffer.from(device.assert('original'), 'base64');
    expectFailure(
      () =>
        verifier.verifyAssertion({
          assertion,
          clientDataHash: sha256('tampered'),
          previousSignCount: 0,
          publicKey,
        }),
      'signature',
    );
    const other = Buffer.from(authority.createDevice().assert('original'), 'base64');
    expectFailure(
      () =>
        verifier.verifyAssertion({
          assertion: other,
          clientDataHash: sha256('original'),
          previousSignCount: 0,
          publicKey,
        }),
      'signature',
    );
  });

  it('binds development keys to their key id', () => {
    const development = authority.createDevelopmentDevice();
    expect(
      verifier.verifyDevelopmentKey({
        keyId: Buffer.from(development.keyId, 'base64'),
        publicKey: Buffer.from(development.publicKey, 'base64'),
      }).signCount,
    ).toBe(0);
    expectFailure(
      () =>
        verifier.verifyDevelopmentKey({
          keyId: Buffer.from(device.keyId, 'base64'),
          publicKey: Buffer.from(development.publicKey, 'base64'),
        }),
      'key-id',
    );
  });
});
