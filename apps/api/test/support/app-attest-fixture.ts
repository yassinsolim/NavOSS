import { createHash, generateKeyPairSync, sign, type KeyObject } from 'node:crypto';

/**
 * Self-generated stand-in for Apple's App Attest PKI and Secure Enclave, used only by tests.
 * Produces a root CA, an intermediate CA, per-device leaf certificates with Apple's nonce
 * extension, attestation objects, and assertions in the formats DCAppAttestService returns.
 */

export type CborInput = CborInput[] | Map<string, CborInput> | number | string | Uint8Array;

function cborHead(major: number, length: number): Buffer {
  if (length < 24) return Buffer.from([(major << 5) | length]);
  if (length < 0x100) return Buffer.from([(major << 5) | 24, length]);
  if (length < 0x10000) {
    const head = Buffer.alloc(3);
    head[0] = (major << 5) | 25;
    head.writeUInt16BE(length, 1);
    return head;
  }
  const head = Buffer.alloc(5);
  head[0] = (major << 5) | 26;
  head.writeUInt32BE(length, 1);
  return head;
}

export function encodeCbor(value: CborInput): Buffer {
  if (typeof value === 'number') return cborHead(0, value);
  if (typeof value === 'string') {
    const bytes = Buffer.from(value, 'utf8');
    return Buffer.concat([cborHead(3, bytes.length), bytes]);
  }
  if (value instanceof Uint8Array) return Buffer.concat([cborHead(2, value.length), value]);
  if (Array.isArray(value)) {
    return Buffer.concat([cborHead(4, value.length), ...value.map(encodeCbor)]);
  }
  return Buffer.concat([
    cborHead(5, value.size),
    ...[...value].flatMap(([key, item]) => [encodeCbor(key), encodeCbor(item)]),
  ]);
}

function der(tag: number, ...contents: Uint8Array[]): Buffer {
  const body = Buffer.concat(contents);
  let length: Buffer;
  if (body.length < 0x80) length = Buffer.from([body.length]);
  else if (body.length < 0x100) length = Buffer.from([0x81, body.length]);
  else {
    length = Buffer.alloc(3);
    length[0] = 0x82;
    length.writeUInt16BE(body.length, 1);
  }
  return Buffer.concat([Buffer.from([tag]), length, body]);
}

function oid(value: string): Buffer {
  const [first = 0, second = 0, ...rest] = value.split('.').map(Number);
  const bytes = [first * 40 + second];
  for (const part of rest) {
    const chunk = [part & 0x7f];
    let remaining = Math.floor(part / 128);
    while (remaining > 0) {
      chunk.unshift((remaining & 0x7f) | 0x80);
      remaining = Math.floor(remaining / 128);
    }
    bytes.push(...chunk);
  }
  return der(0x06, Buffer.from(bytes));
}

const sequence = (...contents: Uint8Array[]): Buffer => der(0x30, ...contents);

function name(commonName: string): Buffer {
  return sequence(der(0x31, sequence(oid('2.5.4.3'), der(0x0c, Buffer.from(commonName)))));
}

function utcTime(date: Date): Buffer {
  const text = date.toISOString().replace(/[-:T]/g, '').slice(2, 14).concat('Z');
  return der(0x17, Buffer.from(text, 'ascii'));
}

function extension(id: string, critical: boolean, value: Uint8Array): Buffer {
  return sequence(oid(id), ...(critical ? [der(0x01, Buffer.from([0xff]))] : []), der(0x04, value));
}

interface CertificateInput {
  ca: boolean;
  extraExtensions?: Buffer[];
  issuer: string;
  issuerKey: KeyObject;
  notAfter: Date;
  notBefore: Date;
  serial: number;
  subject: string;
  subjectPublicKey: KeyObject;
}

let serialCounter = 1;

function certificate(input: CertificateInput): Buffer {
  const issuerIsP384 = input.issuerKey.asymmetricKeyDetails?.namedCurve === 'secp384r1';
  const algorithm = sequence(oid(issuerIsP384 ? '1.2.840.10045.4.3.3' : '1.2.840.10045.4.3.2'));
  const basicConstraints = extension(
    '2.5.29.19',
    true,
    input.ca ? sequence(der(0x01, Buffer.from([0xff]))) : sequence(),
  );
  const tbs = sequence(
    der(0xa0, der(0x02, Buffer.from([0x02]))),
    der(0x02, Buffer.from([input.serial])),
    algorithm,
    name(input.issuer),
    sequence(utcTime(input.notBefore), utcTime(input.notAfter)),
    name(input.subject),
    input.subjectPublicKey.export({ format: 'der', type: 'spki' }),
    der(0xa3, sequence(basicConstraints, ...(input.extraExtensions ?? []))),
  );
  const signature = sign(issuerIsP384 ? 'sha384' : 'sha256', tbs, {
    dsaEncoding: 'der',
    key: input.issuerKey,
  });
  return sequence(tbs, algorithm, der(0x03, Buffer.from([0]), signature));
}

const pem = (derBytes: Buffer): string =>
  `-----BEGIN CERTIFICATE-----\n${derBytes.toString('base64').replace(/(.{64})/g, '$1\n')}\n-----END CERTIFICATE-----\n`;

const sha256 = (...parts: Uint8Array[]): Buffer => {
  const hash = createHash('sha256');
  for (const part of parts) hash.update(part);
  return hash.digest();
};

function uncompressedPoint(key: KeyObject): Buffer {
  const jwk = key.export({ format: 'jwk' });
  return Buffer.concat([
    Buffer.from([0x04]),
    Buffer.from(jwk.x ?? '', 'base64url'),
    Buffer.from(jwk.y ?? '', 'base64url'),
  ]);
}

function assertionAuthenticatorData(rpIdHash: Buffer, counter: number): Buffer {
  const data = Buffer.alloc(37);
  rpIdHash.copy(data, 0);
  // Real devices set the attested-credential flag even in assertions.
  data.writeUInt8(0x40, 32);
  data.writeUInt32BE(counter, 33);
  return data;
}

export interface TestDevice {
  /** Builds a CBOR assertion for `clientData`; advances the counter unless one is given. */
  assert(clientData: string, counter?: number): string;
  readonly counter: number;
  readonly keyId: string;
}

export interface TestAttestedDevice extends TestDevice {
  attest(challenge: string, overrides?: { aaguid?: Buffer; counter?: number }): string;
}

export interface TestDevelopmentDevice extends TestDevice {
  readonly publicKey: string;
}

export interface TestAppAttestAuthorityOptions {
  bundleId: string;
  notAfter?: Date;
  notBefore?: Date;
  teamId: string;
}

export interface TestAppAttestAuthority {
  createDevelopmentDevice(): TestDevelopmentDevice;
  createDevice(options?: { leafNotAfter?: Date }): TestAttestedDevice;
  rootPem: string;
  rpIdHash: Buffer;
}

export function createTestAppAttestAuthority(
  options: TestAppAttestAuthorityOptions,
): TestAppAttestAuthority {
  const notBefore = options.notBefore ?? new Date('2025-01-01T00:00:00Z');
  const notAfter = options.notAfter ?? new Date('2035-01-01T00:00:00Z');
  const rpIdHash = sha256(Buffer.from(`${options.teamId}.${options.bundleId}`));
  const root = generateKeyPairSync('ec', { namedCurve: 'secp384r1' });
  const intermediate = generateKeyPairSync('ec', { namedCurve: 'secp384r1' });
  const rootCertificate = certificate({
    ca: true,
    issuer: 'NavOSS Test App Attestation Root CA',
    issuerKey: root.privateKey,
    notAfter,
    notBefore,
    serial: serialCounter++,
    subject: 'NavOSS Test App Attestation Root CA',
    subjectPublicKey: root.publicKey,
  });
  const intermediateCertificate = certificate({
    ca: true,
    issuer: 'NavOSS Test App Attestation Root CA',
    issuerKey: root.privateKey,
    notAfter,
    notBefore,
    serial: serialCounter++,
    subject: 'NavOSS Test App Attestation CA 1',
    subjectPublicKey: intermediate.publicKey,
  });

  const softwareDevice = (privateKey: KeyObject, publicKey: KeyObject) => {
    let counter = 0;
    const keyIdBytes = sha256(uncompressedPoint(publicKey));
    return {
      assert: (clientData: string, explicitCounter?: number): string => {
        const value = explicitCounter ?? (counter += 1);
        const authenticatorData = assertionAuthenticatorData(rpIdHash, value);
        const nonce = sha256(authenticatorData, sha256(Buffer.from(clientData, 'utf8')));
        const signature = sign('sha256', nonce, { dsaEncoding: 'der', key: privateKey });
        return encodeCbor(
          new Map<string, CborInput>([
            ['signature', signature],
            ['authenticatorData', authenticatorData],
          ]),
        ).toString('base64');
      },
      get counter() {
        return counter;
      },
      keyId: keyIdBytes.toString('base64'),
      keyIdBytes,
    };
  };

  return {
    rootPem: pem(rootCertificate),
    rpIdHash,

    createDevice(deviceOptions: { leafNotAfter?: Date } = {}): TestAttestedDevice {
      const key = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
      const device = softwareDevice(key.privateKey, key.publicKey);
      return {
        assert: device.assert,
        attest(challenge, overrides = {}) {
          const credentialIdLength = Buffer.alloc(2);
          credentialIdLength.writeUInt16BE(device.keyIdBytes.length);
          const counter = Buffer.alloc(4);
          counter.writeUInt32BE(overrides.counter ?? 0);
          const authData = Buffer.concat([
            rpIdHash,
            Buffer.from([0x40]),
            counter,
            overrides.aaguid ?? Buffer.concat([Buffer.from('appattest'), Buffer.alloc(7)]),
            credentialIdLength,
            device.keyIdBytes,
            Buffer.from([0xa0]),
          ]);
          const nonce = sha256(authData, sha256(Buffer.from(challenge, 'utf8')));
          const nonceExtension = extension(
            '1.2.840.113635.100.8.2',
            false,
            sequence(der(0xa1, der(0x04, nonce))),
          );
          const leaf = certificate({
            ca: false,
            extraExtensions: [nonceExtension],
            issuer: 'NavOSS Test App Attestation CA 1',
            issuerKey: intermediate.privateKey,
            notAfter: deviceOptions.leafNotAfter ?? notAfter,
            notBefore,
            serial: serialCounter++,
            subject: device.keyIdBytes.toString('hex'),
            subjectPublicKey: key.publicKey,
          });
          return encodeCbor(
            new Map<string, CborInput>([
              ['fmt', 'apple-appattest'],
              [
                'attStmt',
                new Map<string, CborInput>([
                  ['x5c', [leaf, intermediateCertificate]],
                  ['receipt', Buffer.from('test-receipt')],
                ]),
              ],
              ['authData', authData],
            ]),
          ).toString('base64');
        },
        get counter() {
          return device.counter;
        },
        keyId: device.keyId,
      };
    },

    createDevelopmentDevice(): TestDevelopmentDevice {
      const key = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
      const device = softwareDevice(key.privateKey, key.publicKey);
      return {
        assert: device.assert,
        get counter() {
          return device.counter;
        },
        keyId: device.keyId,
        publicKey: key.publicKey.export({ format: 'der', type: 'spki' }).toString('base64'),
      };
    },
  };
}
