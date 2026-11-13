/**
 * Minimal strict CBOR (RFC 8949) decoder for App Attest attestation and assertion objects.
 * Supports definite-length unsigned/negative integers, byte and text strings, arrays, maps with
 * text or integer keys, and false/true/null. Anything else (indefinite lengths, tags, floats,
 * trailing bytes, excessive nesting) is rejected rather than guessed.
 */
export type CborValue =
  | bigint
  | boolean
  | CborValue[]
  | Map<number | string, CborValue>
  | null
  | number
  | string
  | Uint8Array;

export class CborError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'CborError';
  }
}

const MAX_DEPTH = 16;
const textDecoder = new TextDecoder('utf-8', { fatal: true });

export function decodeCbor(input: Uint8Array): CborValue {
  let offset = 0;

  const take = (length: number): Uint8Array => {
    if (length < 0 || offset + length > input.length) throw new CborError('Truncated CBOR input.');
    const bytes = input.subarray(offset, offset + length);
    offset += length;
    return bytes;
  };

  const readArgument = (additional: number): bigint => {
    if (additional < 24) return BigInt(additional);
    const widths: Record<number, number> = { 24: 1, 25: 2, 26: 4, 27: 8 };
    const width = widths[additional];
    if (width === undefined) throw new CborError('Unsupported CBOR length encoding.');
    let value = 0n;
    for (const byte of take(width)) value = (value << 8n) | BigInt(byte);
    return value;
  };

  const readLength = (additional: number): number => {
    const value = readArgument(additional);
    if (value > BigInt(input.length)) throw new CborError('CBOR length exceeds input.');
    return Number(value);
  };

  const readItem = (depth: number): CborValue => {
    if (depth > MAX_DEPTH) throw new CborError('CBOR nesting is too deep.');
    const [initial] = take(1);
    if (initial === undefined) throw new CborError('Truncated CBOR input.');
    const major = initial >> 5;
    const additional = initial & 0x1f;
    switch (major) {
      case 0: {
        const value = readArgument(additional);
        return value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : value;
      }
      case 1: {
        const value = -1n - readArgument(additional);
        return value >= BigInt(Number.MIN_SAFE_INTEGER) ? Number(value) : value;
      }
      case 2:
        return Uint8Array.from(take(readLength(additional)));
      case 3:
        try {
          return textDecoder.decode(take(readLength(additional)));
        } catch (error: unknown) {
          if (error instanceof CborError) throw error;
          throw new CborError('Invalid UTF-8 in CBOR text string.');
        }
      case 4: {
        const length = readLength(additional);
        const items: CborValue[] = [];
        for (let index = 0; index < length; index += 1) items.push(readItem(depth + 1));
        return items;
      }
      case 5: {
        const length = readLength(additional);
        const map = new Map<number | string, CborValue>();
        for (let index = 0; index < length; index += 1) {
          const key = readItem(depth + 1);
          if (typeof key !== 'string' && typeof key !== 'number') {
            throw new CborError('Unsupported CBOR map key.');
          }
          if (map.has(key)) throw new CborError('Duplicate CBOR map key.');
          map.set(key, readItem(depth + 1));
        }
        return map;
      }
      case 7:
        if (additional === 20) return false;
        if (additional === 21) return true;
        if (additional === 22) return null;
        throw new CborError('Unsupported CBOR simple value.');
      default:
        throw new CborError('Unsupported CBOR major type.');
    }
  };

  const value = readItem(0);
  if (offset !== input.length) throw new CborError('Trailing bytes after CBOR item.');
  return value;
}

export function cborMap(value: CborValue): Map<number | string, CborValue> {
  if (!(value instanceof Map)) throw new CborError('Expected a CBOR map.');
  return value;
}

export function cborBytes(value: CborValue | undefined): Uint8Array {
  if (!(value instanceof Uint8Array)) throw new CborError('Expected a CBOR byte string.');
  return value;
}
