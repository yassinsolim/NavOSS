/**
 * Minimal DER reader used to pull a single extension out of an X.509 certificate. Node's
 * X509Certificate verifies signatures and validity but does not expose arbitrary extensions.
 */
export interface DerElement {
  /** Full identifier octet, e.g. 0x30 for SEQUENCE or 0xa3 for [3] constructed. */
  tag: number;
  value: Uint8Array;
}

export class DerError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'DerError';
  }
}

function readElement(input: Uint8Array, offset: number): { element: DerElement; end: number } {
  const tag = input[offset];
  const firstLength = input[offset + 1];
  if (tag === undefined || firstLength === undefined) throw new DerError('Truncated DER element.');
  if ((tag & 0x1f) === 0x1f) throw new DerError('High-tag-number DER is unsupported.');
  let length = firstLength;
  let cursor = offset + 2;
  if (firstLength & 0x80) {
    const width = firstLength & 0x7f;
    if (width === 0 || width > 4) throw new DerError('Unsupported DER length.');
    length = 0;
    for (let index = 0; index < width; index += 1) {
      const byte = input[cursor];
      if (byte === undefined) throw new DerError('Truncated DER length.');
      length = length * 256 + byte;
      cursor += 1;
    }
  }
  const end = cursor + length;
  if (end > input.length) throw new DerError('DER element exceeds its container.');
  return { element: { tag, value: input.subarray(cursor, end) }, end };
}

export function parseDer(input: Uint8Array): DerElement {
  const { element, end } = readElement(input, 0);
  if (end !== input.length) throw new DerError('Trailing bytes after DER element.');
  return element;
}

export function derChildren(element: DerElement): DerElement[] {
  if ((element.tag & 0x20) === 0) throw new DerError('DER element is not constructed.');
  const children: DerElement[] = [];
  let offset = 0;
  while (offset < element.value.length) {
    const next = readElement(element.value, offset);
    children.push(next.element);
    offset = next.end;
  }
  return children;
}

export function encodeOid(oid: string): Uint8Array {
  const parts = oid.split('.').map(Number);
  const [first = 0, second = 0, ...rest] = parts;
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
  return Uint8Array.from(bytes);
}

const OID_TAG = 0x06;
const OCTET_STRING_TAG = 0x04;
const BOOLEAN_TAG = 0x01;
const EXTENSIONS_TAG = 0xa3;

/** Returns the OCTET STRING payload of the X.509 v3 extension `oid`, or undefined if absent. */
export function findCertificateExtension(
  certificateDer: Uint8Array,
  oid: string,
): Uint8Array | undefined {
  const [tbs] = derChildren(parseDer(certificateDer));
  if (tbs === undefined) throw new DerError('Certificate has no TBSCertificate.');
  const extensionsWrapper = derChildren(tbs).find((child) => child.tag === EXTENSIONS_TAG);
  if (extensionsWrapper === undefined) return undefined;
  const [extensions] = derChildren(extensionsWrapper);
  if (extensions === undefined) return undefined;
  const target = Buffer.from(encodeOid(oid));
  for (const extension of derChildren(extensions)) {
    const [id, ...rest] = derChildren(extension);
    if (id?.tag !== OID_TAG || !target.equals(id.value)) continue;
    const payload = rest.find((child) => child.tag !== BOOLEAN_TAG);
    if (payload?.tag !== OCTET_STRING_TAG) throw new DerError('Malformed certificate extension.');
    return payload.value;
  }
  return undefined;
}
