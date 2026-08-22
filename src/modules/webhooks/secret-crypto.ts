import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12;
const VERSION = 'v1';

/**
 * Envelope encryption for webhook signing secrets.
 *
 * Hashing is not an option: HMAC signing needs the original secret, and the
 * receiver holds the same value (ADR-0008). Format is
 * `v1.<iv>.<tag>.<ciphertext>`, all base64url, so the key version is visible
 * for future rotation.
 */
export function encryptSecret(plaintext: string, keyBase64: string): string {
  const key = decodeKey(keyBase64);
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return [VERSION, iv, cipher.getAuthTag(), ciphertext]
    .map((part) => (typeof part === 'string' ? part : part.toString('base64url')))
    .join('.');
}

export function decryptSecret(envelope: string, keyBase64: string): string {
  const [version, iv, tag, ciphertext] = envelope.split('.');
  if (version !== VERSION || !iv || !tag || !ciphertext) {
    throw new Error('malformed webhook secret envelope');
  }
  const decipher = createDecipheriv(ALGORITHM, decodeKey(keyBase64), Buffer.from(iv, 'base64url'));
  decipher.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([
    decipher.update(Buffer.from(ciphertext, 'base64url')),
    decipher.final(),
  ]).toString('utf8');
}

/** `whsec_` + 32 random bytes, shown to the operator exactly once. */
export function generateWebhookSecret(): string {
  return `whsec_${randomBytes(32).toString('base64url')}`;
}

function decodeKey(keyBase64: string): Buffer {
  const key = Buffer.from(keyBase64, 'base64');
  if (key.length !== 32) throw new Error('WEBHOOK_SECRET_KEY must decode to 32 bytes');
  return key;
}
