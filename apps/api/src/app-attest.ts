import { createHash, createPublicKey, verify, X509Certificate, type KeyObject } from 'node:crypto';

import { cborBytes, cborMap, decodeCbor } from './cbor.js';
import { findCertificateExtension, derChildren, parseDer } from './der.js';

/**
 * Apple App Attestation Root CA, from
 * https://www.apple.com/certificateauthority/Apple_App_Attestation_Root_CA.pem
 * SHA-256 fingerprint 1C:B9:82:3B:A2:8B:A6:AD:2D:33:A0:06:94:1D:E2:AE:4F:51:3E:F1:D4:E8:31:B9:F7:E0:FA:7B:62:42:C9:32
 */
export const APPLE_APP_ATTEST_ROOT_CA_PEM = `-----BEGIN CERTIFICATE-----
MIICITCCAaegAwIBAgIQC/O+DvHN0uD7jG5yH2IXmDAKBggqhkjOPQQDAzBSMSYw
JAYDVQQDDB1BcHBsZSBBcHAgQXR0ZXN0YXRpb24gUm9vdCBDQTETMBEGA1UECgwK
QXBwbGUgSW5jLjETMBEGA1UECAwKQ2FsaWZvcm5pYTAeFw0yMDAzMTgxODMyNTNa
Fw00NTAzMTUwMDAwMDBaMFIxJjAkBgNVBAMMHUFwcGxlIEFwcCBBdHRlc3RhdGlv
biBSb290IENBMRMwEQYDVQQKDApBcHBsZSBJbmMuMRMwEQYDVQQIDApDYWxpZm9y
bmlhMHYwEAYHKoZIzj0CAQYFK4EEACIDYgAERTHhmLW07ATaFQIEVwTtT4dyctdh
NbJhFs/Ii2FdCgAHGbpphY3+d8qjuDngIN3WVhQUBHAoMeQ/cLiP1sOUtgjqK9au
Yen1mMEvRq9Sk3Jm5X8U62H+xTD3FE9TgS41o0IwQDAPBgNVHRMBAf8EBTADAQH/
MB0GA1UdDgQWBBSskRBTM72+aEH/pwyp5frq5eWKoTAOBgNVHQ8BAf8EBAMCAQYw
CgYIKoZIzj0EAwMDaAAwZQIwQgFGnByvsiVbpTKwSga0kP0e8EeDS4+sQmTvb7vn
53O5+FRXgeLhpJ06ysC5PrOyAjEAp5U4xDgEgllF7En3VcE3iexZZtKeYnpqtijV
oyFraWVIyd/dganmrduC1bmTBGwD
-----END CERTIFICATE-----
`;

const NONCE_EXTENSION_OID = '1.2.840.113635.100.8.2';
const AAGUID = {
  development: Buffer.from('appattestdevelop', 'ascii'),
  production: Buffer.concat([Buffer.from('appattest', 'ascii'), Buffer.alloc(7)]),
} as const;
const ATTESTED_CREDENTIAL_DATA_FLAG = 0x40;

export type AppAttestEnvironment = keyof typeof AAGUID;

export type AppAttestFailure =
  | 'malformed'
  | 'certificate'
  | 'nonce'
  | 'key-id'
  | 'app-id'
  | 'counter'
  | 'environment'
  | 'signature';

export class AppAttestError extends Error {
  public constructor(public readonly reason: AppAttestFailure) {
    super(`App Attest verification failed: ${reason}`);
    this.name = 'AppAttestError';
  }
}

export interface AppAttestVerifierOptions {
  bundleId: string;
  environment: AppAttestEnvironment;
  /** Test seam only. Production always uses Apple's App Attestation Root CA. */
  rootCertificatePem?: string;
  teamId: string;
}

export interface VerifiedKey {
  /** DER SubjectPublicKeyInfo of the P-256 credential key. */
  publicKey: Buffer;
  signCount: number;
}

interface AuthenticatorData {
  aaguid?: Buffer;
  credentialId?: Buffer;
  flags: number;
  rpIdHash: Buffer;
  signCount: number;
}

export function sha256(...parts: Uint8Array[]): Buffer {
  const hash = createHash('sha256');
  for (const part of parts) hash.update(part);
  return hash.digest();
}

function parseAuthenticatorData(data: Uint8Array): AuthenticatorData {
  const bytes = Buffer.from(data);
  if (bytes.length < 37) throw new AppAttestError('malformed');
  const flags = bytes.readUInt8(32);
  const parsed: AuthenticatorData = {
    flags,
    rpIdHash: bytes.subarray(0, 32),
    signCount: bytes.readUInt32BE(33),
  };
  if ((flags & ATTESTED_CREDENTIAL_DATA_FLAG) === 0) return parsed;
  if (bytes.length < 55) throw new AppAttestError('malformed');
  const credentialIdLength = bytes.readUInt16BE(53);
  if (bytes.length < 55 + credentialIdLength) throw new AppAttestError('malformed');
  return {
    ...parsed,
    aaguid: bytes.subarray(37, 53),
    credentialId: bytes.subarray(55, 55 + credentialIdLength),
  };
}

/** Uncompressed SEC1 point (0x04 || X || Y) of a P-256 key, as hashed into an App Attest key id. */
function uncompressedP256Point(key: KeyObject): Buffer {
  if (key.asymmetricKeyType !== 'ec' || key.asymmetricKeyDetails?.namedCurve !== 'prime256v1') {
    throw new AppAttestError('key-id');
  }
  const jwk = key.export({ format: 'jwk' });
  if (jwk.x === undefined || jwk.y === undefined) throw new AppAttestError('key-id');
  return Buffer.concat([
    Buffer.from([0x04]),
    Buffer.from(jwk.x, 'base64url'),
    Buffer.from(jwk.y, 'base64url'),
  ]);
}

function isValidAt(certificate: X509Certificate, now: Date): boolean {
  return certificate.validFromDate <= now && now <= certificate.validToDate;
}

function extractNonce(certificate: X509Certificate): Buffer {
  const extension = findCertificateExtension(certificate.raw, NONCE_EXTENSION_OID);
  if (extension === undefined) throw new AppAttestError('nonce');
  // Apple encodes the nonce as SEQUENCE { [1] EXPLICIT OCTET STRING }.
  const [tagged] = derChildren(parseDer(extension));
  if (tagged?.tag !== 0xa1) throw new AppAttestError('nonce');
  const [octets] = derChildren(tagged);
  if (octets?.tag !== 0x04) throw new AppAttestError('nonce');
  return Buffer.from(octets.value);
}

export interface AppAttestVerifier {
  /** SHA-256(teamId.bundleId), the App Attest relying-party id hash. */
  readonly rpIdHash: Buffer;
  verifyAssertion(input: {
    assertion: Uint8Array;
    clientDataHash: Uint8Array;
    previousSignCount: number;
    publicKey: Uint8Array;
  }): { signCount: number };
  verifyAttestation(input: {
    attestationObject: Uint8Array;
    clientDataHash: Uint8Array;
    keyId: Uint8Array;
    now: Date;
  }): VerifiedKey;
  verifyDevelopmentKey(input: { keyId: Uint8Array; publicKey: Uint8Array }): VerifiedKey;
}

export function createAppAttestVerifier(options: AppAttestVerifierOptions): AppAttestVerifier {
  const root = new X509Certificate(options.rootCertificatePem ?? APPLE_APP_ATTEST_ROOT_CA_PEM);
  const rpIdHash = sha256(Buffer.from(`${options.teamId}.${options.bundleId}`, 'utf8'));
  const expectedAaguid = AAGUID[options.environment];

  const verifyChain = (x5c: Uint8Array[], now: Date): X509Certificate => {
    if (x5c.length !== 2) throw new AppAttestError('certificate');
    let leaf: X509Certificate;
    let intermediate: X509Certificate;
    try {
      leaf = new X509Certificate(x5c[0] ?? new Uint8Array());
      intermediate = new X509Certificate(x5c[1] ?? new Uint8Array());
    } catch {
      throw new AppAttestError('certificate');
    }
    const chainIsValid =
      root.ca &&
      intermediate.ca &&
      [root, intermediate, leaf].every((certificate) => isValidAt(certificate, now)) &&
      intermediate.checkIssued(root) &&
      intermediate.verify(root.publicKey) &&
      leaf.checkIssued(intermediate) &&
      leaf.verify(intermediate.publicKey);
    if (!chainIsValid) throw new AppAttestError('certificate');
    return leaf;
  };

  return {
    rpIdHash,

    verifyAttestation({ attestationObject, clientDataHash, keyId, now }) {
      let fmt: unknown;
      let authDataBytes: Uint8Array;
      let x5c: Uint8Array[];
      try {
        const object = cborMap(decodeCbor(attestationObject));
        fmt = object.get('fmt');
        authDataBytes = cborBytes(object.get('authData'));
        const statement = cborMap(object.get('attStmt') ?? null);
        const chain = statement.get('x5c');
        if (!Array.isArray(chain)) throw new AppAttestError('malformed');
        x5c = chain.map((entry) => cborBytes(entry));
      } catch (error: unknown) {
        if (error instanceof AppAttestError) throw error;
        throw new AppAttestError('malformed');
      }
      if (fmt !== 'apple-appattest') throw new AppAttestError('malformed');

      const leaf = verifyChain(x5c, now);
      const nonce = sha256(authDataBytes, clientDataHash);
      if (!nonce.equals(extractNonce(leaf))) throw new AppAttestError('nonce');

      const point = uncompressedP256Point(leaf.publicKey);
      const keyIdBuffer = Buffer.from(keyId);
      if (!sha256(point).equals(keyIdBuffer)) throw new AppAttestError('key-id');

      const authData = parseAuthenticatorData(authDataBytes);
      if (!authData.rpIdHash.equals(rpIdHash)) throw new AppAttestError('app-id');
      if (authData.signCount !== 0) throw new AppAttestError('counter');
      if (!authData.aaguid?.equals(expectedAaguid)) {
        throw new AppAttestError('environment');
      }
      if (!authData.credentialId?.equals(keyIdBuffer)) {
        throw new AppAttestError('key-id');
      }
      return {
        publicKey: leaf.publicKey.export({ format: 'der', type: 'spki' }),
        signCount: 0,
      };
    },

    verifyAssertion({ assertion, clientDataHash, previousSignCount, publicKey }) {
      let signature: Uint8Array;
      let authDataBytes: Uint8Array;
      try {
        const object = cborMap(decodeCbor(assertion));
        signature = cborBytes(object.get('signature'));
        authDataBytes = cborBytes(object.get('authenticatorData'));
      } catch {
        throw new AppAttestError('malformed');
      }
      const authData = parseAuthenticatorData(authDataBytes);
      const nonce = sha256(authDataBytes, clientDataHash);
      const key = createPublicKey({ format: 'der', key: Buffer.from(publicKey), type: 'spki' });
      if (!verify('sha256', nonce, { dsaEncoding: 'der', key }, signature)) {
        throw new AppAttestError('signature');
      }
      if (!authData.rpIdHash.equals(rpIdHash)) throw new AppAttestError('app-id');
      if (authData.signCount <= previousSignCount) throw new AppAttestError('counter');
      return { signCount: authData.signCount };
    },

    verifyDevelopmentKey({ keyId, publicKey }) {
      let key: KeyObject;
      try {
        key = createPublicKey({ format: 'der', key: Buffer.from(publicKey), type: 'spki' });
      } catch {
        throw new AppAttestError('malformed');
      }
      if (!sha256(uncompressedP256Point(key)).equals(Buffer.from(keyId))) {
        throw new AppAttestError('key-id');
      }
      return { publicKey: key.export({ format: 'der', type: 'spki' }), signCount: 0 };
    },
  };
}
