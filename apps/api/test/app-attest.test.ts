import { createHash, createPublicKey, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';

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

/**
 * Genuine Apple-signed vectors from independent open-source verifiers (see
 * test/fixtures/app-attest/PROVENANCE.txt). They are verified against the pinned production Apple
 * root, with no test-root override, so they check Apple's conventions rather than our own signer.
 */
describe('genuine Apple App Attest vectors', () => {
  const fixture = (name: string): string =>
    readFileSync(new URL(`./fixtures/app-attest/${name}`, import.meta.url), 'utf8');
  const field = (document: string, key: string): string => {
    const match = new RegExp(`^${key}: '?([^'\\n]+)'?$`, 'm').exec(document);
    if (match?.[1] === undefined) throw new Error(`Missing ${key}`);
    return match[1];
  };

  for (const name of ['veehaitch-ios-14.2.yaml', 'veehaitch-ios-14.4.yaml']) {
    const documents = fixture(name).split('\n---\n');
    const attestation = documents.find((document) => /^type: attestation$/m.test(document)) ?? '';
    const assertion = documents.find((document) => /^type: assertion$/m.test(document)) ?? '';
    const verifierFor = (environment: 'development' | 'production') =>
      createAppAttestVerifier({
        bundleId: field(attestation, 'bundleIdentifier'),
        environment,
        teamId: field(attestation, 'teamIdentifier'),
      });
    const clientDataHash = createHash('sha256')
      .update(Buffer.from(field(attestation, 'clientDataBase64'), 'base64'))
      .digest();
    const attest = (environment: 'development' | 'production') =>
      verifierFor(environment).verifyAttestation({
        attestationObject: Buffer.from(field(attestation, 'attestationBase64'), 'base64'),
        clientDataHash,
        keyId: Buffer.from(field(attestation, 'keyIdBase64'), 'base64'),
        now: new Date(field(attestation, 'timestamp')),
      });

    it(`${name}: verifies the real attestation chain to Apple's root and extracts the key`, () => {
      const verified = attest('development');
      const expected = createPublicKey(
        /-----BEGIN PUBLIC KEY-----[\s\S]+?-----END PUBLIC KEY-----/
          .exec(attestation)?.[0]
          .replace(/^ +/gm, '') ?? '',
      ).export({ format: 'der', type: 'spki' });
      expect(verified.publicKey.equals(expected)).toBe(true);
      expectFailure(() => attest('production'), 'environment');
    });

    it(`${name}: verifies the real assertion signature and counter convention`, () => {
      const { publicKey } = attest('development');
      const verifier = verifierFor('development');
      const assertionBytes = Buffer.from(field(assertion, 'assertionBase64'), 'base64');
      const assertionClientDataHash = createHash('sha256')
        .update(Buffer.from(field(assertion, 'clientDataBase64'), 'base64'))
        .digest();
      expect(
        verifier.verifyAssertion({
          assertion: assertionBytes,
          clientDataHash: assertionClientDataHash,
          previousSignCount: 0,
          publicKey,
        }),
      ).toEqual({ signCount: Number(field(assertion, 'counter')) });
      expectFailure(
        () =>
          verifier.verifyAssertion({
            assertion: assertionBytes,
            clientDataHash: sha256('wurzelpfropf2'),
            previousSignCount: 0,
            publicKey,
          }),
        'signature',
      );
      expectFailure(
        () =>
          verifier.verifyAssertion({
            assertion: assertionBytes,
            clientDataHash: assertionClientDataHash,
            previousSignCount: 1,
            publicKey,
          }),
        'counter',
      );
    });
  }

  it("verifies Apple's published production sample from the attestation validation guide", () => {
    const verifier = createAppAttestVerifier({
      bundleId: 'com.example.myapp',
      environment: 'production',
      teamId: '1234567890',
    });
    const input = {
      attestationObject: Buffer.from(
        fixture('takimoto3-apple-guide-attestation.b64').trim(),
        'base64',
      ),
      keyId: Buffer.from('zgSY9YSD+7TaDXssY6WlOPVS1K3Lmk+pFhlcSWE+ZV0=', 'base64'),
      now: new Date('2026-04-21T18:13:12Z'),
    };
    // Apple's sample was formed from the raw challenge, as its expected values show.
    const verified = verifier.verifyAttestation({
      ...input,
      clientDataHash: Buffer.from('example_server_challenge', 'utf8'),
    });
    expect(verified.signCount).toBe(0);
    expectFailure(
      () =>
        verifier.verifyAttestation({
          ...input,
          clientDataHash: sha256('example_server_challenge'),
        }),
      'nonce',
    );
    expectFailure(
      () =>
        verifier.verifyAttestation({
          ...input,
          clientDataHash: Buffer.from('example_server_challenge'),
          now: new Date('2026-04-24T00:00:00Z'),
        }),
      'certificate',
    );
  });
});
