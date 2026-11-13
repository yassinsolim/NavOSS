import { createCipheriv, createDecipheriv, createHmac, randomBytes } from 'node:crypto';

const SEED_BYTES = 16;
const IV_BYTES = 12;
const AUTH_TAG_BYTES = 16;
// Seed, expiry, and the end of the installation's newcomer period (both whole seconds).
const PLAINTEXT_BYTES = SEED_BYTES + 4 + 4;
const SEALED_BYTES = IV_BYTES + AUTH_TAG_BYTES + PLAINTEXT_BYTES;

export interface OpenedCredential {
  /**
   * True while the installation that obtained the credential is still in its newcomer period.
   * Newly registered installations are capped per network in each cohort.
   */
  newInstallation: boolean;
  seed: Buffer;
}

export interface TrafficCredentials {
  /**
   * Seals the installation's contributor seed, an expiry, and the end of its newcomer period into
   * an opaque credential. The installation id is used here and nowhere else: it is not in the
   * credential and is not kept.
   */
  issue(
    installationId: string,
    nowMs: number,
    newUntilMs: number,
  ): { credential: string; expiresAtMs: number };
  /** What a credential carries, or undefined when it is forged or expired. */
  open(credential: string, nowMs: number): OpenedCredential | undefined;
  /**
   * Contributor tag for one segment. Tags of one contributor on different segments are unrelated,
   * so the cohorts held in memory cannot be joined into a path by tag equality.
   */
  tagFor(seed: Buffer, segmentKey: string): string;
}

/**
 * Contributor identity for community traffic, built on the App Attest installations of community
 * reports without tying anything stored to an installation.
 *
 * - One installation always maps to the same seed under one process key, whatever network it
 *   uploads from and however many credentials it asks for. That is what lets one device count
 *   once per segment per cohort.
 * - The seed is a keyed hash, so it cannot be turned back into an installation id, and the key
 *   exists only in this process's memory. A restart invalidates every credential and makes old
 *   seeds unrepeatable.
 * - The credential is AES-256-GCM sealed: the app cannot read, alter or mint one.
 *
 * This is not an anonymous credential. While a credential is valid, the API process can tell
 * that two batches carry the same one; it never stores or logs that fact.
 */
export function createTrafficCredentials(
  lifetimeSeconds: number,
  key: Buffer = randomBytes(32),
): TrafficCredentials {
  const sealingKey = createHmac('sha256', key).update('navoss-traffic-credential-seal').digest();
  const seedKey = createHmac('sha256', key).update('navoss-traffic-contributor-seed').digest();

  return {
    issue(installationId, nowMs, newUntilMs) {
      const seed = createHmac('sha256', seedKey)
        .update(installationId)
        .digest()
        .subarray(0, SEED_BYTES);
      const expiresAtSeconds = Math.floor(nowMs / 1_000) + lifetimeSeconds;
      const times = Buffer.alloc(8);
      times.writeUInt32BE(expiresAtSeconds, 0);
      times.writeUInt32BE(Math.max(0, Math.ceil(newUntilMs / 1_000)), 4);
      const iv = randomBytes(IV_BYTES);
      const cipher = createCipheriv('aes-256-gcm', sealingKey, iv);
      const sealed = Buffer.concat([cipher.update(seed), cipher.update(times), cipher.final()]);
      return {
        credential: Buffer.concat([iv, cipher.getAuthTag(), sealed]).toString('base64url'),
        expiresAtMs: expiresAtSeconds * 1_000,
      };
    },

    open(credential, nowMs) {
      const bytes = Buffer.from(credential, 'base64url');
      if (bytes.length !== SEALED_BYTES) return undefined;
      try {
        const decipher = createDecipheriv('aes-256-gcm', sealingKey, bytes.subarray(0, IV_BYTES));
        decipher.setAuthTag(bytes.subarray(IV_BYTES, IV_BYTES + AUTH_TAG_BYTES));
        const opened = Buffer.concat([
          decipher.update(bytes.subarray(IV_BYTES + AUTH_TAG_BYTES)),
          decipher.final(),
        ]);
        if (opened.readUInt32BE(SEED_BYTES) * 1_000 <= nowMs) return undefined;
        return {
          newInstallation: opened.readUInt32BE(SEED_BYTES + 4) * 1_000 > nowMs,
          seed: opened.subarray(0, SEED_BYTES),
        };
      } catch {
        return undefined;
      }
    },

    tagFor(seed, segmentKey) {
      return createHmac('sha256', seed).update(segmentKey).digest('base64url').slice(0, 16);
    },
  };
}
