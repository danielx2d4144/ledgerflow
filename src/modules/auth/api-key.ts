import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Opaque API-key encoding: `lf_<tag>_<prefix>.<secret>`.
 *
 *  - `tag` is `live` in production and `test` everywhere else, so a staging key
 *    pasted into production fails loudly instead of silently doing nothing.
 *  - `prefix` is public and indexed: it turns verification into a single index
 *    lookup instead of hashing every row.
 *  - `secret` is 256 bits of CSPRNG output, base64url encoded. It is shown once
 *    at creation and never stored.
 */
export const KEY_PATTERN = /^lf_(live|test)_([0-9a-f]{16})\.([A-Za-z0-9_-]{43})$/;

export const PREFIX_LENGTH = 16;

export interface ParsedApiKey {
  tag: 'live' | 'test';
  prefix: string;
  secret: string;
}

export function keyTagFor(nodeEnv: string): 'live' | 'test' {
  return nodeEnv === 'production' ? 'live' : 'test';
}

export function parseApiKey(raw: string): ParsedApiKey | null {
  const match = KEY_PATTERN.exec(raw.trim());
  if (!match) return null;
  const [, tag, prefix, secret] = match;
  return { tag: tag as 'live' | 'test', prefix: prefix as string, secret: secret as string };
}

export interface GeneratedApiKey extends ParsedApiKey {
  /** Full plaintext key. Returned to the caller exactly once. */
  token: string;
}

export function generateApiKey(tag: 'live' | 'test'): GeneratedApiKey {
  const prefix = randomBytes(PREFIX_LENGTH / 2).toString('hex');
  const secret = randomBytes(32).toString('base64url');
  return { tag, prefix, secret, token: `lf_${tag}_${prefix}.${secret}` };
}

/**
 * Peppered HMAC-SHA256 rather than a memory-hard KDF.
 *
 * Password KDFs exist to slow down guessing of low-entropy human secrets. These
 * secrets are 256 random bits, so offline brute force is already impossible; the
 * realistic threat is a leaked database, which the server-side pepper defeats
 * because the pepper never lives in Postgres. In exchange verification stays
 * sub-millisecond, which keeps the auth cache an optimisation rather than a
 * requirement. See ADR-0007.
 */
export function hashSecret(secret: string, pepper: string): string {
  return createHmac('sha256', pepper).update(secret).digest('hex');
}

/** Constant-time comparison of two hex digests of equal length. */
export function secretMatches(secret: string, pepper: string, storedHash: string): boolean {
  const computed = Buffer.from(hashSecret(secret, pepper), 'hex');
  if (!/^[0-9a-f]{64}$/i.test(storedHash)) return false;
  const stored = Buffer.from(storedHash, 'hex');
  if (stored.length !== computed.length) return false;
  return timingSafeEqual(computed, stored);
}

/** Display form kept in logs and list responses: never reversible to a secret. */
export function redactedKey(tag: 'live' | 'test', prefix: string): string {
  return `lf_${tag}_${prefix}.${'*'.repeat(8)}`;
}
