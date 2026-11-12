import { createHmac, randomBytes } from 'node:crypto';
import { isIPv4, isIPv6 } from 'node:net';

/**
 * Reduces a network address to the unit one contributor is assumed to hold: a whole IPv4 address,
 * or the /64 prefix of an IPv6 address, because phones rotate the lower 64 bits freely.
 */
export function contributorNetwork(address: string): string {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address)?.[1];
  if (mapped !== undefined && isIPv4(mapped)) return mapped;
  if (!isIPv6(address)) return address;
  const [head = '', tail] = address.split('%')[0]?.split('::') ?? [];
  const headGroups = head === '' ? [] : head.split(':');
  const tailGroups = tail === undefined || tail === '' ? [] : tail.split(':');
  const groups =
    tail === undefined
      ? headGroups
      : [
          ...headGroups,
          ...new Array<string>(Math.max(0, 8 - headGroups.length - tailGroups.length)).fill('0'),
          ...tailGroups,
        ];
  return groups
    .slice(0, 4)
    .map((group) => Number.parseInt(group, 16).toString(16))
    .join(':');
}

export interface ContributorTokens {
  /** Signed 64-bit token as a decimal string, ready for a PostgreSQL `bigint`. */
  tokenFor(sourceAddress: string, segmentKey: string): string;
}

/**
 * Counts independent contributors without an account or installation id. A token is a keyed hash
 * of the network and one segment, so the same driver has unrelated tokens on different roads and
 * tokens cannot be joined into a path. The key exists only in this process's memory: once the
 * process ends, stored tokens can no longer be tied to any address.
 */
export function createContributorTokens(key: Buffer = randomBytes(32)): ContributorTokens {
  return {
    tokenFor(sourceAddress, segmentKey) {
      return createHmac('sha256', key)
        .update(contributorNetwork(sourceAddress))
        .update('\n')
        .update(segmentKey)
        .digest()
        .readBigInt64BE(0)
        .toString();
    },
  };
}
